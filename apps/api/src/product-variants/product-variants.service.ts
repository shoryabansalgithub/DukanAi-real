import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { rethrowUniqueViolation } from '../common/db/unique-violation';
import { attributeMatrixProblem, countCombinations, MAX_VARIANT_COMBINATIONS } from './dto/generate-variants.dto';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../iam/tenant-context/tenant-context.service';

@Injectable()
export class ProductVariantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async createAttribute(name: string, values: string[]) {
    const shopId = this.tenantContext.getShopId();
    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-');

    return this.prisma.$transaction(async (tx) => {
        let attribute = await tx.variantAttribute.findUnique({
            where: { shopId_slug: { shopId, slug } }
        });

        if (!attribute) {
            attribute = await tx.variantAttribute.create({
                data: { shopId, name, slug }
            });
        }

        const createdValues = [];
        for (const val of values) {
            const valSlug = val.toLowerCase().replace(/[^a-z0-9]/g, '-');
            const attrVal = await tx.variantAttributeValue.upsert({
                where: { attributeId_slug: { attributeId: attribute.id, slug: valSlug } },
                update: {},
                create: { attributeId: attribute.id, value: val, slug: valSlug }
            });
            createdValues.push(attrVal);
        }

        return { attribute, values: createdValues };
    });
  }

  async generateVariants(productId: string, attributes: { [key: string]: string[] }) {
      const shopId = this.tenantContext.getShopId();
      
      const product = await this.prisma.product.findFirst({
          where: { id: productId, shopId, isDeleted: false }
      });
      if (!product) throw new NotFoundException('Product not found');

      // Roadmap 5.2: the matrix is bounded before it is expanded (the DTO checks the same; this guards direct callers).
      const problem = attributeMatrixProblem(attributes);
      if (problem) {
        throw new BadRequestException({ message: problem, code: countCombinations(attributes) > MAX_VARIANT_COMBINATIONS ? 'VARIANT_MATRIX_TOO_LARGE' : 'VARIANT_MATRIX_INVALID' });
      }

      // Cartesian product of the value lists, in attribute order.
      const keys = Object.keys(attributes);
      const combinations = keys.reduce<string[][]>((acc, key) => acc.flatMap((prefix) => attributes[key].map((value) => [...prefix, value])), [[]]);

      // One SKU per combination, unique within the matrix (release audit S20: "Red" and
      // "Redwood" both shortened to RED and the second variant was silently dropped).
      const used = new Set<string>();
      const planned = combinations.map((comboValues) => {
          const base = `${product.sku}-${comboValues.map((v) => v.substring(0, 3).toUpperCase()).join('-')}`;
          let sku = base;
          for (let n = 2; used.has(sku); n++) sku = `${base}-${n}`;
          used.add(sku);
          return { comboValues, sku };
      });
      const skus = planned.map((p) => p.sku);

      return this.prisma.$transaction(async (tx) => {
          // 1. Bulk Create Variants. A SKU this product already has is its own
          // variant (a re-run); one another product holds is a conflict, reported, never skipped.
          const taken = await tx.productVariant.findMany({ where: { shopId, sku: { in: skus }, isDeleted: false }, select: { sku: true, productId: true } });
          const foreign = taken.filter((v) => v.productId !== productId).map((v) => v.sku);
          if (foreign.length > 0) {
              throw new ConflictException({ message: `These variant SKUs are already used by another product: ${foreign.join(', ')}.`, code: 'VARIANT_SKU_CONFLICT', details: { skus: foreign } });
          }
          const own = new Set(taken.map((v) => v.sku));
          const variantData = planned.filter((p) => !own.has(p.sku)).map((p) => ({
              productId,
              shopId,
              sku: p.sku,
              costPrice: product.costPrice,
              sellingPrice: product.sellingPrice,
              mrp: product.mrp,
          }));

          try {
              if (variantData.length > 0) await tx.productVariant.createMany({ data: variantData });
          } catch (error) {
              rethrowUniqueViolation(error, [{ index: 'sku', code: 'VARIANT_SKU_CONFLICT', message: 'A variant SKU was taken concurrently; retry.' }]);
          }

          const variants = await tx.productVariant.findMany({
              where: { shopId, productId, sku: { in: skus }, isDeleted: false }
          });
          const variantMap = new Map(variants.map((v) => [v.sku, v]));

          // 2. Process Attributes and Values efficiently
          const attributeValueIds = new Map<string, string>(); // 'AttrName:AttrVal' -> attributeValueId
          
          for (const attrName of keys) {
              const attrVals = attributes[attrName];
              const slug = attrName.toLowerCase().replace(/[^a-z0-9]/g, '-');
              
              let attribute = await tx.variantAttribute.findUnique({
                  where: { shopId_slug: { shopId, slug } }
              });

              if (!attribute) {
                  attribute = await tx.variantAttribute.create({
                      data: { shopId, name: attrName, slug }
                  });
              }

              for (const val of attrVals) {
                  const valSlug = val.toLowerCase().replace(/[^a-z0-9]/g, '-');
                  const attrVal = await tx.variantAttributeValue.upsert({
                      where: { attributeId_slug: { attributeId: attribute.id, slug: valSlug } },
                      update: {},
                      create: { attributeId: attribute.id, value: val, slug: valSlug }
                  });
                  attributeValueIds.set(`${attrName}:${val}`, attrVal.id);
              }
          }

          // 3. Link Variants and Attributes
          const linkData: Array<{ variantId: string; attributeValueId: string }> = [];
          for (const { comboValues, sku } of planned) {
              const variant = variantMap.get(sku);
              if (!variant) continue;
              for (let i = 0; i < keys.length; i++) {
                  const attrValId = attributeValueIds.get(`${keys[i]}:${comboValues[i]}`);
                  if (attrValId) linkData.push({ variantId: variant.id, attributeValueId: attrValId });
              }
          }

          if (linkData.length > 0) {
              await tx.productVariantAttribute.createMany({
                  data: linkData,
                  skipDuplicates: true
              });
          }

          // Update product type to VARIABLE
          await tx.product.update({
              where: { id: productId },
              data: { type: 'VARIABLE' }
          });

          return variants;
      });
  }
}
