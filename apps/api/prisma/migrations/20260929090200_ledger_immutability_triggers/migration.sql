-- Roadmap 3.12 (audit P2-35): the ledger is append-only. The two triggers
-- that `setup-triggers.ts` used to create by hand (never wired into any
-- deployment) now ship as a migration, so every database that runs
-- `migrate deploy` refuses an UPDATE or DELETE on LedgerTransaction. Each
-- trigger is one statement, so no DELIMITER is needed. `prisma migrate diff`
-- does not model triggers, so the drift check stays at zero.
DROP TRIGGER IF EXISTS `prevent_ledger_update`;
DROP TRIGGER IF EXISTS `prevent_ledger_delete`;
CREATE TRIGGER `prevent_ledger_update` BEFORE UPDATE ON `LedgerTransaction` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ledger records are strictly immutable.';
CREATE TRIGGER `prevent_ledger_delete` BEFORE DELETE ON `LedgerTransaction` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ledger records are strictly immutable.';
