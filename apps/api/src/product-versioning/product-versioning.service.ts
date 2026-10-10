import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';
import * as jsonpatch from 'fast-json-patch';
import * as crypto from 'crypto';

@Injectable()
export class ProductVersioningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private computeHash(data: any, parentRevId: string | null): string {
    const payload = JSON.stringify(data) + (parentRevId || '');
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  async createDraft(productId: string, branchName: string = 'main') {
    const shopId = this.tenantContext.getShopId();
    const userId = this.tenantContext.getUserId();

    const product = await this.prisma.product.findFirst({
      where: { id: productId, shopId, isDeleted: false },
      include: { variants: true, images: true, attributes: true, tags: true }
    });

    if (!product) throw new NotFoundException('Product not found');

    // Find or create branch
    let branch = await this.prisma.revisionBranch.findUnique({
      where: { productId_name: { productId, name: branchName } }
    });

    if (!branch) {
      branch = await this.prisma.revisionBranch.create({
        data: {
          productId,
          name: branchName,
          baseRevId: product.currentPublishedRevId || 'init',
        }
      });
    }

    const currentVersion = await this.prisma.productRevision.count({
        where: { productId }
    });

    const data = JSON.parse(JSON.stringify(product));

    const revision = await this.prisma.productRevision.create({
      data: {
        productId,
        branchId: branch.id,
        shopId,
        versionNumber: currentVersion + 1,
        parentRevId: product.currentPublishedRevId,
        isSnapshot: true,
        data,
        contentHash: this.computeHash(data, product.currentPublishedRevId),
        status: 'DRAFT',
        authorId: userId,
      }
    });

    await this.prisma.product.update({
        where: { id: productId },
        data: { currentDraftRevId: revision.id }
    });

    return revision;
  }

  async saveDraft(revisionId: string, updatedData: any) {
    const shopId = this.tenantContext.getShopId();
    
    const revision = await this.prisma.productRevision.findFirst({
        where: { id: revisionId, shopId, status: 'DRAFT' }
    });
    
    if (!revision) throw new NotFoundException('Draft revision not found');

    const newHash = this.computeHash(updatedData, revision.parentRevId);
    
    // Check if anything actually changed
    if (newHash === revision.contentHash) {
        return revision; // No-op
    }

    // Generate diff from parent if exists
    let diff: jsonpatch.Operation[] = [];
    if (revision.parentRevId) {
        const parent = await this.prisma.productRevision.findUnique({ where: { id: revision.parentRevId } });
        if (parent) {
            diff = jsonpatch.compare(parent.data as any, updatedData);
        }
    }

    const updated = await this.prisma.productRevision.update({
        where: { id: revisionId },
        data: {
            data: updatedData,
            contentHash: newHash,
        }
    });

    if (diff.length > 0 && revision.parentRevId) {
        await this.prisma.revisionDiff.upsert({
            where: {
                sourceRevId_targetRevId: {
                    sourceRevId: revision.parentRevId,
                    targetRevId: revisionId
                }
            },
            create: {
                sourceRevId: revision.parentRevId,
                targetRevId: revisionId,
                patch: diff as any
            },
            update: {
                patch: diff as any
            }
        });
    }

    return updated;
  }

  async publish(revisionId: string) {
    const shopId = this.tenantContext.getShopId();
    const revision = await this.prisma.productRevision.findFirst({
        where: { id: revisionId, shopId, status: 'APPROVED' }
    });

    if (!revision) throw new BadRequestException('Revision must be APPROVED to publish');

    const product = await this.prisma.product.findUnique({ where: { id: revision.productId }});
    if (!product) throw new NotFoundException('Product not found');
    
    // OCC Check
    if (product.currentPublishedRevId && product.currentPublishedRevId !== revision.parentRevId) {
        throw new ConflictException('Optimistic Locking Failure: Another revision was published while this draft was pending.');
    }

    await this.prisma.$transaction([
        // Supersede old
        ...(product.currentPublishedRevId ? [
            this.prisma.productRevision.update({
                where: { id: product.currentPublishedRevId },
                data: { status: 'SUPERSEDED' }
            })
        ] : []),
        
        // Publish new
        this.prisma.productRevision.update({
            where: { id: revisionId },
            data: { status: 'PUBLISHED', publishedAt: new Date() }
        }),

        // Update pointer
        this.prisma.product.update({
            where: { id: revision.productId },
            data: { 
                currentPublishedRevId: revisionId,
                currentDraftRevId: null,
                version: product.version + 1
            }
        })
    ]);

    return { success: true, newVersion: product.version + 1 };
  }

  async approve(revisionId: string, comments?: string) {
      const shopId = this.tenantContext.getShopId();
      const userId = this.tenantContext.getUserId();

      const revision = await this.prisma.productRevision.findFirst({
          where: { id: revisionId, shopId, status: 'PENDING_REVIEW' }
      });
      if (!revision) throw new NotFoundException('Revision not found or not pending');

      const signature = crypto.createHash('sha256').update(`${revisionId}-${userId}-${Date.now()}`).digest('hex');

      await this.prisma.$transaction([
          this.prisma.revisionApproval.create({
              data: {
                  revisionId,
                  reviewerId: userId,
                  status: 'APPROVED',
                  comments,
                  digitalSignature: signature,
                  resolvedAt: new Date()
              }
          }),
          this.prisma.productRevision.update({
              where: { id: revisionId },
              data: { status: 'APPROVED' }
          })
      ]);

      return { success: true };
  }

  async submitForReview(revisionId: string) {
      const shopId = this.tenantContext.getShopId();
      const revision = await this.prisma.productRevision.findFirst({
          where: { id: revisionId, shopId, status: 'DRAFT' }
      });
      if (!revision) throw new NotFoundException('Draft not found');

      return this.prisma.productRevision.update({
          where: { id: revisionId },
          data: { status: 'PENDING_REVIEW' }
      });
  }

  async getDiff(revA: string, revB: string) {
      const shopId = this.tenantContext.getShopId();
      // Both revisions must be this shop's before any stored diff is served.
      const [a, b] = await Promise.all([
          this.prisma.productRevision.findFirst({ where: { id: revA, shopId } }),
          this.prisma.productRevision.findFirst({ where: { id: revB, shopId } })
      ]);

      if (!a || !b) throw new NotFoundException('Revisions not found');

      const diff = await this.prisma.revisionDiff.findUnique({
          where: {
              sourceRevId_targetRevId: { sourceRevId: revA, targetRevId: revB }
          }
      });
      if (diff) return diff.patch;

      return jsonpatch.compare(a.data as any, b.data as any);
  }
}
