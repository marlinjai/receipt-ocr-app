---
title: Verified receipts production backups
summary: Schedule receipts database dumps, keep a separate copy, and prove scratch restoration.
type: plan
status: completed
tags: [operations, backups, recovery]
projects: [receipt-ocr-app]
date: 2026-10-09
---

# Verified receipts production backups

Approved by the autonomous portfolio execution goal on 2026-10-09.

## Decision

Create an enabled Coolify database backup schedule every six hours, retaining 28
copies locally for up to seven days. Run the initial scheduled job immediately.
Keep an independent off-server copy using existing infrastructure, preferring an
existing Simple Storage Service (S3) compatible object-store destination. Retain
at least 30 days of daily recovery points off-server. Do not purchase a new server.

This caps routine database data loss at six hours without introducing continuous
write-ahead-log archiving. Take another on-demand backup before migrations.
Financial source documents live separately in the file store; the database dump
protects their references, not the file bytes. Record and verify that boundary.

## Completion tests

1. Read back the enabled schedule and retention from Coolify.
2. A job produces a nonempty dump with a recorded checksum.
3. Restore that dump into an isolated empty scratch database with failure-on-error.
4. Compare every public table row count and schema against the source snapshot,
   with only aggregate counts and checksums in output.
5. Verify receipt, guest, finance and migration records survived restoration.
6. Remove only the scratch resources created by this test.
7. Verify a copy exists on an independent host or object store, then schedule it.
8. Record a recovery runbook, production health check and exact remaining limits.

No production table is modified by the rehearsal. Backup files remain private.

## Verified result

Completed on 2026-10-09. The scheduled 104,985-byte dump restored 28 public tables
and 639 rows. Every table count, logical column definition, constraint and index
matched production. The scratch container had no network and was removed.

The dump checksum matched the off-server copy on Hermes. An hourly systemd timer
copies six-hourly recovery points and retains 30 days. The source key is restricted
to a read-only rsync export of the receipts backup directory. No new recurring
hosting cost. See `docs/operations/production-recovery.md` for evidence and commands.

The existing European Union R2 destination was subsequently discovered in the
contacts schedule. Receipts now uploads every dump there too, with 120 copies
retained for up to 30 days. An independently downloaded R2 dump restored the same
28 tables and 639 rows. This adds no fixed hosting cost; normal existing R2 usage
charges apply.
