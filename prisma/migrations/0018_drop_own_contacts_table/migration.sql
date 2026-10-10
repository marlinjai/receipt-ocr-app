-- Drops the receipts app's OWN contacts table. It is not the shared contacts
-- database: that one runs on a different server and is not touched here.
--
-- The 4 rows this table held were copied to the shared contacts database under
-- the same ids on 2026-10-09 (a repeat of the move created nothing), and the app
-- has read and written only the shared database since the switch on that day.
-- The receipts database has a verified backup every six hours, which is the only
-- way back once this has run.
DROP TABLE "contacts";
