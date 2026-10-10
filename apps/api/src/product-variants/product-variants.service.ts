import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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

      return this.prisma.$transaction(async (tx) => {
          // 1. Bulk Create Variants
          const variantData = combinations.map((combination: any) => {
              const comboValues = Array.isArray(combination) ? combination : [combination];
              const skuSuffix = comboValues.map((v: any) => v.substring(0, 3).toUpperCase()).join('-');
              return {
                  productId,
                  shopId,
                  sku: `${product.sku}-${skuSuffix}`,
                  costPrice: product.costPrice,
                  sellingPrice: product.sellingPrice,
                  mrp: product.mrp,
              };
          });

          await tx.productVariant.createMany({
              data: variantData,
              skipDuplicates: true
          });

          const createdVariantSkus = variantData.map((v: any) => v.sku);
          const variants = await tx.productVariant.findMany({
              where: { shopId, sku: { in: createdVariantSkus }, isDeleted: false }
          });
          const variantMap = new Map(variants.map((v: any) => [v.sku, v]));

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
          const linkData: any[] = [];
          for (const combination of combinations) {
              const comboValues = Array.isArray(combination) ? combination : [combination];
              const skuSuffix = comboValues.map((v: any) => v.substring(0, 3).toUpperCase()).join('-');
              const variantSku = `${product.sku}-${skuSuffix}`;
              const variant = variantMap.get(variantSku);

              if (variant) {
                  for (let i = 0; i < keys.length; i++) {
                      const attrName = keys[i];
                      const attrVal = comboValues[i];
                      const attrValId = attributeValueIds.get(`${attrName}:${attrVal}`);
                      
                      if (attrValId) {
                          linkData.push({
                              variantId: variant.id,
                              attributeValueId: attrValId
                          });
                      }
                  }
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
