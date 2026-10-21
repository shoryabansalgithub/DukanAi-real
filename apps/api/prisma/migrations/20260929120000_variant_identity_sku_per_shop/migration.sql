-- Roadmap 4.1: VariantIdentity.sku was unique across every shop, so a second
-- shop could never register an identity for a SKU another shop already used.
-- The key becomes (shopId, sku). The new index is created first so the
-- lookup never loses its index, then the global one is dropped.
CREATE UNIQUE INDEX `VariantIdentity_shopId_sku_key` ON `VariantIdentity`(`shopId`, `sku`);
DROP INDEX `VariantIdentity_sku_key` ON `VariantIdentity`;
