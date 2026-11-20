-- Roadmap 9.24 (privacy): customer repayments and opening balances wrote the
-- customer's name into the ledger description (`Customer payment <name>
-- (CASH)`, `Opening balance <name>`). LedgerTransaction is immutable (the
-- triggers of 20260929090200 / 20261003090100), so a name stored there could
-- never be erased on a deletion request. The writers now leave the name out
-- (the posting's sourceId names the UdharTransaction, which names the
-- customer); this migration removes the names already written.
--
-- The update trigger is dropped for the duration of this script only and
-- recreated with the same compound body (never DELIMITER: the server splits
-- the script). Only the description changes: amounts, accounts, dates and
-- balances are untouched, so every ledger figure and reconciliation result is
-- the same afterwards. Idempotent: a description without a name no longer
-- matches the patterns (`Customer payment (CASH)` has no " (" after a name).
DROP TRIGGER IF EXISTS `prevent_ledger_update`;

UPDATE `LedgerTransaction` t
  JOIN `LedgerPosting` p ON p.`id` = t.`postingId`
  SET t.`description` = CONCAT('Customer payment ', SUBSTRING_INDEX(t.`description`, ' ', -1))
  WHERE p.`sourceType` = 'CUSTOMER_PAYMENT' AND t.`description` LIKE 'Customer payment % (%)';

UPDATE `LedgerTransaction` t
  JOIN `LedgerPosting` p ON p.`id` = t.`postingId`
  SET t.`description` = 'Opening balance'
  WHERE p.`sourceType` = 'OPENING_BALANCE' AND t.`description` LIKE 'Opening balance %';

UPDATE `LedgerPosting`
  SET `description` = CONCAT('Customer payment ', SUBSTRING_INDEX(`description`, ' ', -1))
  WHERE `sourceType` = 'CUSTOMER_PAYMENT' AND `description` LIKE 'Customer payment % (%)';

UPDATE `LedgerPosting`
  SET `description` = 'Opening balance'
  WHERE `sourceType` = 'OPENING_BALANCE' AND `description` LIKE 'Opening balance %';

CREATE TRIGGER `prevent_ledger_update` BEFORE UPDATE ON `LedgerTransaction` FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Ledger records are strictly immutable.';
END;
