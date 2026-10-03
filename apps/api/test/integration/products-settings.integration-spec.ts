/**
 * Roadmap 6.2 / 6.3 over the real stack: the products list is a real page
 * with `q`, category and stock filters, a SKU is numbered by the server when
 * the client sends none, edit / delete persist, and the shop profile fields
 * the settings page writes (state, city, pincode, phone, email) decide the
 * IGST / CGST+SGST split of a sale.
 */
import { INestApplication } from '@nestjs/common';
import { PAGE_HEADERS } from '../../src/common/pagination';
import { bootApp, createShop, TestShop } from './pos-fixtures';
import { httpAs, ownerOf } from '../security/security-fixtures';

jest.setTimeout(300_000);

type Owner = Awaited<ReturnType<typeof httpAs>>;

interface ProductRow {
  id: string;
  name: string;
  sku: string;
  categoryId: string | null;
  currentStock: string | number;
  category: { id: string; name: string } | null;
}

function productBody(name: string, extra: Record<string, unknown> = {}) {
  return { name, costPrice: 60, sellingPrice: 100, mrp: 110, wholesalePrice: 90, unit: 'PCS', gstRate: 'FIVE', ...extra };
}

async function createProduct(owner: Owner, name: string, extra: Record<string, unknown> = {}): Promise<ProductRow> {
  const res = await owner.post('/api/products').send(productBody(name, extra));
  expect([name, res.status, res.body]).toEqual([name, 201, expect.anything()]);
  return res.body as ProductRow;
}

async function setStock(owner: Owner, productId: string, quantity: number): Promise<void> {
  const item = await owner.post('/api/inventory-domain').send({ productId });
  expect(item.status).toBe(201);
  const adjust = await owner.post(`/api/inventory-domain/${item.body.id}/adjust`).send({ reason: 'OPENING_BALANCE', quantityChange: quantity });
  expect([adjust.status, adjust.body]).toEqual([201, expect.anything()]);
}

describe('Products page and settings over HTTP (roadmap 6.2, 6.3)', () => {
  let app: INestApplication;
  let A: TestShop;
  let owner: Owner;

  beforeAll(async () => {
    app = await bootApp();
    A = await createShop(app, 'p62');
    owner = await httpAs(app, A, ownerOf(A));
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('6.2 products', () => {
    it('numbers the SKU on the server when the client sends none, and keeps a supplied one', async () => {
      const first = await createProduct(owner, 'No SKU one');
      const second = await createProduct(owner, 'No SKU two');
      expect(first.sku).toMatch(/^SKU-\d{6}$/);
      expect(second.sku).toMatch(/^SKU-\d{6}$/);
      expect(Number(second.sku.slice(4))).toBe(Number(first.sku.slice(4)) + 1);

      const supplied = await createProduct(owner, 'Own SKU', { sku: `OWN-${A.suffix}` });
      expect(supplied.sku).toBe(`OWN-${A.suffix}`);
      // A blank SKU counts as none.
      const blank = await createProduct(owner, 'Blank SKU', { sku: '   ' });
      expect(blank.sku).toMatch(/^SKU-\d{6}$/);

      const duplicate = await owner.post('/api/products').send(productBody('Dup', { sku: `OWN-${A.suffix}` }));
      expect(duplicate.status).toBe(400);
    });

    it('lists a page with headers, q, category and stock filters that match the dashboard definitions', async () => {
      const category = await owner.post('/api/categories').send({ name: `Beverages ${A.suffix}` });
      expect(category.status).toBe(201);

      const out = await createProduct(owner, `Filter out ${A.suffix}`, { categoryId: category.body.id });
      const low = await createProduct(owner, `Filter low ${A.suffix}`, { categoryId: category.body.id });
      const inStock = await createProduct(owner, `Filter in ${A.suffix}`);
      const service = await createProduct(owner, `Filter service ${A.suffix}`, { type: 'SERVICE' });
      await setStock(owner, low.id, 5); // reorderPoint defaults to 10
      await setStock(owner, inStock.id, 50);

      const page = await owner.get(`/api/products?q=${encodeURIComponent(`Filter`)}&limit=2&offset=1`);
      expect(page.status).toBe(200);
      expect(Array.isArray(page.body)).toBe(true);
      expect(page.body).toHaveLength(2);
      expect(page.headers[PAGE_HEADERS.total.toLowerCase()]).toBe('4');
      expect(page.headers[PAGE_HEADERS.skip.toLowerCase()]).toBe('1');
      expect(page.headers[PAGE_HEADERS.take.toLowerCase()]).toBe('2');
      expect((await owner.get('/api/products?limit=5000')).status).toBe(400);
      expect((await owner.get('/api/products?limit=abc')).status).toBe(400);
      expect((await owner.get('/api/products?stock=maybe')).status).toBe(400);

      const ids = async (qs: string) => {
        const res = await owner.get(`/api/products?q=Filter&${qs}`);
        expect([qs, res.status]).toEqual([qs, 200]);
        return (res.body as ProductRow[]).map((p) => p.id).sort();
      };
      expect(await ids(`categoryId=${category.body.id}`)).toEqual([out.id, low.id].sort());
      expect(await ids('stock=out')).toEqual([out.id]);
      expect(await ids('stock=low')).toEqual([low.id]);
      expect(await ids('stock=in')).toEqual([inStock.id, service.id].sort());
      expect(await ids(`stock=out&categoryId=${category.body.id}`)).toEqual([out.id]);

      const row = (page.body as ProductRow[])[0];
      expect(row).toHaveProperty('category');
      expect(row).toHaveProperty('currentStock');
    });

    it('edits persist and a delete removes the product from the list', async () => {
      const product = await createProduct(owner, `Editable ${A.suffix}`);
      const patch = await owner.patch(`/api/products/${product.id}`).send({ name: 'Edited name', gstRate: 'EIGHTEEN', unit: 'KG', sellingPrice: 120, mrp: 130, costPrice: 70 });
      expect([patch.status, patch.body]).toEqual([200, expect.anything()]);
      const read = await owner.get(`/api/products/${product.id}`);
      expect(read.body).toMatchObject({ name: 'Edited name', gstRate: 'EIGHTEEN', unit: 'KG' });
      expect(Number(read.body.sellingPrice)).toBe(120);

      expect((await owner.delete(`/api/products/${product.id}`)).status).toBe(204);
      expect((await owner.get(`/api/products/${product.id}`)).status).toBe(404);
      const list = await owner.get(`/api/products?q=${encodeURIComponent('Edited name')}`);
      expect((list.body as ProductRow[]).some((p) => p.id === product.id)).toBe(false);
    });
  });

  describe('6.3 settings decide the tax split', () => {
    it('the profile fields persist and the shop state drives IGST on a sale', async () => {
      const product = await createProduct(owner, `Taxed ${A.suffix}`);
      const profile = { name: `Shop ${A.suffix}`, address: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560001', phone: '9876543210', email: `shop-${A.suffix}@example.com`, gstin: '29ABCDE1234F1Z5' };
      const saved = await owner.patch('/api/shops/me').send(profile);
      expect([saved.status, saved.body]).toEqual([200, expect.anything()]);
      const read = await owner.get('/api/shops/me');
      expect(read.body).toMatchObject({ city: 'Bengaluru', state: 'Karnataka', pincode: '560001', phone: '9876543210', email: profile.email });
      expect(read.body.settings.gstin).toBe('29ABCDE1234F1Z5');
      expect((await owner.patch('/api/shops/me').send({ email: 'not-an-email' })).status).toBe(400);
      expect((await owner.patch('/api/shops/me').send({ pincode: '12345678901' })).status).toBe(400);

      const outOfState = await owner.post('/api/customers').send({ name: 'Delhi buyer', phone: `8${A.suffix.replace(/\D/g, '').slice(-9).padStart(9, '1')}`, state: 'Delhi' });
      expect(outOfState.status).toBe(201);
      const inState = await owner.post('/api/customers').send({ name: 'Local buyer', phone: `7${A.suffix.replace(/\D/g, '').slice(-9).padStart(9, '2')}`, state: 'Karnataka' });
      expect(inState.status).toBe(201);

      const calc = (customerId?: string) => owner.post('/api/billing/calculate').send({ items: [{ productId: product.id, quantity: 1 }], customerId });
      const interState = await calc(outOfState.body.id);
      expect(interState.status).toBe(200);
      expect(interState.body).toMatchObject({ isInterState: true, shopState: 'Karnataka', customerState: 'Delhi' });
      expect(Number(interState.body.totalIgst)).toBeGreaterThan(0);
      expect(Number(interState.body.totalCgst)).toBe(0);

      const intraState = await calc(inState.body.id);
      expect(intraState.body).toMatchObject({ isInterState: false });
      expect(Number(intraState.body.totalIgst)).toBe(0);
      expect(Number(intraState.body.totalCgst)).toBeGreaterThan(0);

      // Without a shop state nothing can be inter-state, which is why the settings page must carry the field.
      expect((await owner.patch('/api/shops/me').send({ state: '' })).status).toBe(200);
      expect((await calc(outOfState.body.id)).body).toMatchObject({ isInterState: false, shopState: '' });
      expect((await owner.patch('/api/shops/me').send({ state: 'Karnataka' })).status).toBe(200);
    });
  });
});
