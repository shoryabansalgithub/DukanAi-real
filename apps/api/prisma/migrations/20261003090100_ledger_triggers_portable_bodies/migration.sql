-- Roadmap 7.7 (found by the restore drill): on MySQL 8, Prisma applies a
-- migration as one multi-statement script, and the server stored the first
-- trigger of 20260929090200 with its statement terminator inside the body
-- (`SIGNAL ... ;`). mysqldump then writes `... ; */;;` for it, which the mysql
-- client refuses on restore (syntax error near ' */'). A compound body ends at
-- END, so it is stored, dumped and restored cleanly on MySQL 8 and MariaDB
-- alike. Same rule as before: no DELIMITER (the server, not a client, splits
-- the script), and `prisma migrate diff` does not model triggers.
DROP TRIGGER IF EXISTS `prevent_ledger_update`;
DROP TRIGGER IF EXISTS `prevent_ledger_delete`;
CREATE TRIGGER `prevent_ledger_update` BEFORE UPDATE ON `LedgerTransaction` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ledger records are strictly immutable.';
END;
CREATE TRIGGER `prevent_ledger_delete` BEFORE DELETE ON `LedgerTransaction` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ledger records are strictly immutable.';
END;
