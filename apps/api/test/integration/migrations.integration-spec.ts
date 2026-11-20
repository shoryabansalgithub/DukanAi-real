/**
 * Roadmap 3.3 / 3.10 / 3.12: the phase 3 migrations on a populated database.
 * A scratch database is built up to the migration before phase 3, seeded
 * with the rows the audit worried about (returns made before
 * `returnedQuantity` existed, live duplicates, soft-deleted rows), migrated
 * to phase 3, and checked. The convergence migration is then re-applied
 * where it stands in the history, to prove it is a no-op on a database that
 * already has the structure, and every later migration runs on the
 * populated database, in order, as an upgrade would: the result is
 * schema.prisma.
 *
 * Only migrations older than phase 3 go into the seeded history. The later
 * ones used to be applied before phase 3 as well, an order no deployment
 * has; once a later migration extended an enum the convergence migration
 * also declares (OPENING_BALANCE_EQUITY on the ledger accounts, roadmap
 * 9.20), that order narrowed the enum again and the database no longer
 * matched the schema.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as mysql from 'mysql2/promise';

const PHASE3 = ['20260929090000_phase3_money_uniques_indexes', '20260929090100_foundation_convergence', '20260929090200_ledger_immutability_triggers'];

describe('phase 3 migrations on a populated database', () => {
  const apiRoot = path.resolve(__dirname, '..', '..');
  const baseUrl = new URL(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '');
  const scratchDb = `${baseUrl.pathname.replace('/', '')}_mig`;
  const scratchUrl = new URL(baseUrl.toString());
  scratchUrl.pathname = `/${scratchDb}`;
  let admin: mysql.Connection;
  let db: mysql.Connection;
  let tmp: string;

  const migrationsDir = path.join(apiRoot, 'prisma', 'migrations');
  /** Every migration directory, in the order Prisma applies them (by name). */
  const migrations = () => fs.readdirSync(migrationsDir).filter((d) => d !== 'migration_lock.toml').sort();
  const copyMigration = (dir: string) => {
    fs.mkdirSync(path.join(tmp, 'migrations', dir));
    fs.copyFileSync(path.join(migrationsDir, dir, 'migration.sql'), path.join(tmp, 'migrations', dir, 'migration.sql'));
  };
  const deploy = (schemaPath: string) =>
    execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', schemaPath], { cwd: apiRoot, env: { ...process.env, DATABASE_URL: scratchUrl.toString() }, stdio: 'pipe' }).toString();

  const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const [result] = await db.query(sql, params);
    return result as T[];
  };

  beforeAll(async () => {
    admin = await mysql.createConnection({ host: baseUrl.hostname, port: Number(baseUrl.port || 3306), user: decodeURIComponent(baseUrl.username), password: decodeURIComponent(baseUrl.password) });
    await admin.query(`DROP DATABASE IF EXISTS \`${scratchDb}\``);
    await admin.query(`CREATE DATABASE \`${scratchDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);

    // The migration history before phase 3, in a scratch prisma folder.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dukaanai-mig-'));
    fs.mkdirSync(path.join(tmp, 'migrations'));
    fs.copyFileSync(path.join(apiRoot, 'prisma', 'schema.prisma'), path.join(tmp, 'schema.prisma'));
    fs.copyFileSync(path.join(migrationsDir, 'migration_lock.toml'), path.join(tmp, 'migrations', 'migration_lock.toml'));
    for (const dir of migrations().filter((d) => d < PHASE3[0])) copyMigration(dir);
    deploy(path.join(tmp, 'schema.prisma'));

    db = await mysql.createConnection({ host: baseUrl.hostname, port: Number(baseUrl.port || 3306), user: decodeURIComponent(baseUrl.username), password: decodeURIComponent(baseUrl.password), database: scratchDb, multipleStatements: true });
    await seed();
  }, 300_000);

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS \`${scratchDb}\``);
    await admin?.end();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A shop with returns that predate `returnedQuantity`, duplicate live rows and soft-deleted rows. */
  async function seed() {
    const now = '2026-09-01 10:00:00.000';
    await db.query(`
      SET FOREIGN_KEY_CHECKS = 0;
      INSERT INTO Shop (id, name, updatedAt) VALUES ('shop1', 'Fixture shop', '${now}');
      INSERT INTO User (id, email, name, role, shopId, updatedAt) VALUES ('user1', 'owner@fixture.test', 'Owner', 'OWNER', 'shop1', '${now}');
      UPDATE Shop SET ownerId = 'user1' WHERE id = 'shop1';
      INSERT INTO Customer (id, name, phone, shopId, updatedAt, createdAt) VALUES
        ('c-old', 'Old', '9000000001', 'shop1', '${now}', '2026-08-01 10:00:00.000'),
        ('c-dup', 'Dup', '9000000001', 'shop1', '${now}', '2026-08-02 10:00:00.000'),
        ('c-del', 'Del', '9000000002', 'shop1', '${now}', '2026-08-01 10:00:00.000');
      UPDATE Customer SET isDeleted = 1, deletedAt = '${now}' WHERE id = 'c-del';
      INSERT INTO Product (id, name, sku, barcode, costPrice, sellingPrice, mrp, wholesalePrice, shopId, unit, updatedAt, createdAt) VALUES
        ('p-old', 'Old', 'SKU-1', 'BC-1', 1, 2, 2, 2, 'shop1', 'PCS', '${now}', '2026-08-01 10:00:00.000'),
        ('p-dup', 'Dup', 'SKU-1', 'BC-2', 1, 2, 2, 2, 'shop1', 'PCS', '${now}', '2026-08-02 10:00:00.000'),
        ('p-del', 'Del', 'SKU-2', NULL, 1, 2, 2, 2, 'shop1', 'PCS', '${now}', '2026-08-01 10:00:00.000'),
        ('p-two', 'Two', 'SKU-3', NULL, 1, 2, 2, 2, 'shop1', 'PCS', '${now}', '2026-08-01 10:00:00.000');
      UPDATE Product SET isDeleted = 1, deletedAt = '${now}' WHERE id = 'p-del';
      INSERT INTO Invoice (id, invoiceNumber, idempotencyKey, financialYear, shopId, cashierId, subtotal, taxableAmount, cgstAmount, sgstAmount, taxAmount, discountAmount, totalAmount, paidAmount, changeAmount, paymentMode, status, type, originalId, updatedAt) VALUES
        ('inv-sale', 'INV-1', 'k1', '2026-27', 'shop1', 'user1', 8, 8, 0, 0, 0, 0, 8, 8, 0, 'CASH', 'COMPLETED', 'SALE', NULL, '${now}'),
        ('inv-ret1', 'RET-1', 'k2', '2026-27', 'shop1', 'user1', 2, 2, 0, 0, 0, 0, 2, 2, 0, 'CASH', 'COMPLETED', 'SALES_RETURN', 'inv-sale', '${now}'),
        ('inv-ret2', 'RET-2', 'k3', '2026-27', 'shop1', 'user1', 2, 2, 0, 0, 0, 0, 2, 2, 0, 'CASH', 'COMPLETED', 'SALES_RETURN', 'inv-sale', '${now}'),
        ('inv-void', 'RET-3', 'k4', '2026-27', 'shop1', 'user1', 2, 2, 0, 0, 0, 0, 2, 2, 0, 'CASH', 'CANCELLED', 'SALES_RETURN', 'inv-sale', '${now}');
      INSERT INTO InvoiceItem (id, invoiceId, productId, productName, productSku, quantity, unit, costPrice, sellingPrice, mrp, gstRate, cgstAmount, sgstAmount, totalAmount, returnedQuantity, updatedAt) VALUES
        ('li-sale-old', 'inv-sale', 'p-old', 'Old', 'SKU-1', 4, 'PCS', 1, 2, 2, 'ZERO', 0, 0, 8, 0, '${now}'),
        ('li-sale-two', 'inv-sale', 'p-two', 'Two', 'SKU-3', 1, 'PCS', 1, 2, 2, 'ZERO', 0, 0, 2, 0, '${now}'),
        ('li-ret1', 'inv-ret1', 'p-old', 'Old', 'SKU-1', 1, 'PCS', 1, 2, 2, 'ZERO', 0, 0, 2, 0, '${now}'),
        ('li-ret2', 'inv-ret2', 'p-old', 'Old', 'SKU-1', 1, 'PCS', 1, 2, 2, 'ZERO', 0, 0, 2, 0, '${now}'),
        ('li-ret2b', 'inv-ret2', 'p-two', 'Two', 'SKU-3', 5, 'PCS', 1, 2, 2, 'ZERO', 0, 0, 10, 0, '${now}'),
        ('li-void', 'inv-void', 'p-old', 'Old', 'SKU-1', 1, 'PCS', 1, 2, 2, 'ZERO', 0, 0, 2, 0, '${now}');
      INSERT INTO LedgerTransaction (id, shopId, account, type, amount, balanceAfter) VALUES ('lt1', 'shop1', 'CASH', 'DEBIT', 8, 8);
      INSERT INTO Supplier (id, name, phone, shopId, pendingPayables, updatedAt) VALUES ('s1', 'Supplier', '9000000009', 'shop1', 1234.50, '${now}');
      SET FOREIGN_KEY_CHECKS = 1;
    `);
  }

  it('applies the three phase 3 migrations on top of the seeded history', () => {
    for (const dir of PHASE3) copyMigration(dir);
    const output = deploy(path.join(tmp, 'schema.prisma'));
    for (const name of PHASE3) expect(output).toContain(name);
  }, 300_000);

  it('3.3 recomputes returnedQuantity from completed returns, capped at the sold quantity', async () => {
    const items = await rows<{ id: string; returnedQuantity: string }>('SELECT id, returnedQuantity FROM InvoiceItem WHERE invoiceId = ? ORDER BY id', ['inv-sale']);
    expect(items).toEqual([
      { id: 'li-sale-old', returnedQuantity: '2.000' }, // two completed returns of one unit; the cancelled one does not count
      { id: 'li-sale-two', returnedQuantity: '1.000' }, // 5 returned against 1 sold: capped
    ]);
  });

  it('3.10 stamps tokens on deleted rows, exempts pre-existing live duplicates, and the new key rejects a fresh duplicate', async () => {
    const customers = await rows<{ id: string; deletedToken: string }>('SELECT id, deletedToken FROM Customer ORDER BY id');
    expect(customers).toEqual([
      { id: 'c-del', deletedToken: 'c-del' },
      { id: 'c-dup', deletedToken: 'c-dup' }, // the younger duplicate is exempted, not deleted
      { id: 'c-old', deletedToken: '' },
    ]);
    const products = await rows<{ id: string; deletedToken: string }>('SELECT id, deletedToken FROM Product ORDER BY id');
    expect(products).toEqual([
      { id: 'p-del', deletedToken: 'p-del' },
      { id: 'p-dup', deletedToken: 'p-dup' },
      { id: 'p-old', deletedToken: '' },
      { id: 'p-two', deletedToken: '' },
    ]);
    const indexes = await rows<{ INDEX_NAME: string; NON_UNIQUE: number }>(
      "SELECT INDEX_NAME, MIN(NON_UNIQUE) AS NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('Customer', 'Product') AND INDEX_NAME LIKE '%deletedToken_key' GROUP BY INDEX_NAME ORDER BY INDEX_NAME",
    );
    expect(indexes.map((i) => i.INDEX_NAME)).toEqual(['Customer_shopId_phone_deletedToken_key', 'Product_shopId_barcode_deletedToken_key', 'Product_shopId_sku_deletedToken_key']);
    expect(indexes.every((i) => Number(i.NON_UNIQUE) === 0)).toBe(true);
    const old = await rows("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME LIKE '%deletedAt_key'");
    expect(old).toHaveLength(0);

    await expect(db.query("INSERT INTO Customer (id, name, phone, shopId, updatedAt) VALUES ('c-new', 'New', '9000000001', 'shop1', NOW(3))")).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    // A deleted row never blocks its key.
    await db.query("INSERT INTO Customer (id, name, phone, shopId, updatedAt) VALUES ('c-new', 'New', '9000000002', 'shop1', NOW(3))");
  });

  it('3.2 widens the money columns and 3.11 seeds the opening payable', async () => {
    const cols = await rows<{ COLUMN_NAME: string; COLUMN_TYPE: string }>(
      "SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND ((TABLE_NAME = 'LedgerTransaction' AND COLUMN_NAME IN ('amount', 'balanceAfter')) OR (TABLE_NAME = 'Customer' AND COLUMN_NAME IN ('totalPurchases', 'totalPaid'))) ORDER BY TABLE_NAME, COLUMN_NAME",
    );
    expect(cols).toEqual([
      { COLUMN_NAME: 'totalPaid', COLUMN_TYPE: 'decimal(14,2)' },
      { COLUMN_NAME: 'totalPurchases', COLUMN_TYPE: 'decimal(14,2)' },
      { COLUMN_NAME: 'amount', COLUMN_TYPE: 'decimal(14,2)' },
      { COLUMN_NAME: 'balanceAfter', COLUMN_TYPE: 'decimal(18,2)' },
    ]);
    await db.query("INSERT INTO LedgerTransaction (id, shopId, account, type, amount, balanceAfter) VALUES ('lt2', 'shop1', 'CASH', 'DEBIT', 100, 9999999999999999.99)");
    const supplier = await rows<{ openingPayables: string; pendingPayables: string }>('SELECT openingPayables, pendingPayables FROM Supplier WHERE id = ?', ['s1']);
    expect(supplier[0]).toEqual({ openingPayables: '1234.50', pendingPayables: '1234.50' });
  });

  it('3.12 installs the ledger immutability triggers', async () => {
    await expect(db.query("UPDATE LedgerTransaction SET amount = 1 WHERE id = 'lt1'")).rejects.toMatchObject({ sqlState: '45000' });
    await expect(db.query("DELETE FROM LedgerTransaction WHERE id = 'lt1'")).rejects.toMatchObject({ sqlState: '45000' });
  });

  it('3.12 the convergence migration is idempotent, and every later migration then brings the populated database to schema.prisma', () => {
    const convergence = path.join(migrationsDir, '20260929090100_foundation_convergence', 'migration.sql');
    execFileSync('npx', ['prisma', 'db', 'execute', '--url', scratchUrl.toString(), '--file', convergence], { cwd: apiRoot, stdio: 'pipe' });
    const later = migrations().filter((d) => d > PHASE3[PHASE3.length - 1]);
    expect(later.length).toBeGreaterThan(0);
    const output = deploy(path.join(apiRoot, 'prisma', 'schema.prisma'));
    for (const name of later) expect(output).toContain(name);
    execFileSync('npx', ['prisma', 'migrate', 'diff', '--from-url', scratchUrl.toString(), '--to-schema-datamodel', 'prisma/schema.prisma', '--exit-code'], { cwd: apiRoot, stdio: 'pipe' });
  }, 300_000);
});
