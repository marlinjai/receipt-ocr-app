---
title: Receipts production database recovery
summary: Scheduled recovery points, off-server copies, isolated restoration, and operational limits.
type: documentation
tags: [operations, backups, recovery]
projects: [receipt-ocr-app]
date: 2026-10-09
---

# Receipts production database recovery

The receipts database has a recovery point every six hours. Restoring a dump can
lose changes made since that dump. Always take an extra dump immediately before a
destructive migration, verify it, and preserve current state before any recovery.

## Active configuration

| Setting | Value |
| --- | --- |
| Database | `receipts`, user `receipts`, PostgreSQL 16 |
| Production container | `zmnnqmxbksrj5vzy6ffy1wod` on `157.90.119.98` |
| Coolify schedule | `ss422ub14y7rxd4cfylki1qp`, enabled |
| Frequency | `17 */6 * * *`, Coordinated Universal Time (UTC) |
| Local retention | 28 copies, up to seven days |
| Local directory | `/data/coolify/backups/databases/root-team-0/receipts-postgres-zmnnqmxbksrj5vzy6ffy1wod/` |
| Object storage | Existing Cloudflare R2 bucket `lumitra-db-backups`, European Union jurisdiction |
| Object retention | 120 copies, up to 30 days, uploaded by each Coolify backup job |
| Additional off-server copy | Hermes, `/var/lib/receipts-backups/`, root-only |
| Copy schedule | `receipts-backup-pull.timer`, hourly at minute 30 UTC with up to 60 seconds random delay |
| Off-server retention | All available six-hour recovery points for 30 days |
| New recurring cost | No new fixed hosting cost; existing R2 storage and request usage applies |

The timer is persistent, so a missed run is caught up after reboot. Copy failures,
empty or unexpectedly small dumps, and backups older than eight hours fail the
service and remain visible in the system journal. `last-success.json` stores the
latest successful copy's time, size and checksum without any personal data.

Hermes uses its existing Secure Shell (SSH) key. The production authorized-key
entry has `restrict` and a forced command that runs `rrsync -ro` against only the
receipts backup directory. It cannot request a shell, forward ports, modify
production, or read other directories. The production host key was copied through
an already authenticated connection into a dedicated known-hosts file.

The native object-storage destination is Coolify storage `a10f3pejsxb2q7a6l15egu5m`.
The older Coolify installation does not expose its storage-list endpoint, but the
existing configured destination was read through its model with only non-secret
metadata selected. Credentials were consumed on the host that already owns them;
no values were printed or transferred into this repository.

The scripts and systemd units installed on both hosts are in
`scripts/operations/`. Never print a private key or database connection string.

## Verify a recovery point

Run from a trusted checkout, passing the chosen dump as the positional argument:

```sh
ssh root@157.90.119.98 python3 - \
  /data/coolify/backups/databases/root-team-0/receipts-postgres-zmnnqmxbksrj5vzy6ffy1wod/pg-dump-receipts-1791582022.dmp \
  < scripts/operations/verify-production-backup.py
```

The verifier starts a temporary container using the production database image,
with no network, no published ports, bounded memory, and a temporary data volume.
It waits for the final database server process, restores with `pg_restore
--single-transaction --exit-on-error`, and compares every public table count,
logical column definition, constraint, and index. Output contains aggregate counts
and a file checksum only. It removes its own scratch container even after failure.

Dropped columns can leave physical ordinal gaps in PostgreSQL. Restoration closes
those gaps. The comparison normalizes numbering while preserving column order,
types, defaults and nullability. It does not treat that expected storage detail as
lost schema.

Run during a quiet write period: comparison is against the live database. Legitimate
writes after the dump can cause a mismatch, which must be investigated rather than
ignored. An old historical dump should be compared against the expected historical
state in an isolated scratch database, never blindly against current production.

To inspect the independent copy and schedule:

```sh
ssh hermes 'systemctl status receipts-backup-pull.timer --no-pager'
ssh hermes 'systemctl show receipts-backup-pull.service -p Result -p ExecMainStatus'
ssh hermes 'cat /var/lib/receipts-backups/last-success.json'
```

A manual pull is `ssh hermes 'systemctl start receipts-backup-pull.service'`.
Compare the copy's checksum with the tested source dump before relying on it.

## Recover safely

1. Stop the faulty operation and identify the time and extent of damage.
2. Take and preserve a new dump of the current state, even if damaged.
3. Copy the candidate dump from local storage or Hermes to an isolated recovery
   environment. Verify its checksum and restore there before touching production.
4. Prefer recovering only missing or damaged rows. Preserve newer correct writes.
5. If whole-database replacement is necessary, stop application writes, preserve a
   rollback dump, and explicitly approve the exact point in time and lost writes.
6. Restore into an empty database with the matching PostgreSQL major version and
   `--single-transaction --exit-on-error --no-owner --no-privileges`.
7. Inspect the migration ledger. Do not automatically replay the migration that
   caused the incident. Apply only reviewed migrations.
8. Point the app at the verified restored database, restart it, check
   `https://receipts.lumitra.co/api/health`, and verify actual receipt, meal and
   finance reads for the intended company before resuming writes.

## Evidence from the initial rehearsal

On 2026-10-09 at 21:40:22 UTC, Coolify execution
`ptk5mbseztw21ofpq74r7tc6` completed successfully. Its dump was 104,985 bytes.
Restoration matched 28 public tables, 639 rows, 15 nonempty tables, all logical
column definitions, constraints and indexes. The temporary container was removed.
Production health returned Hypertext Transfer Protocol (HTTP) status 200.

Secure Hash Algorithm 256 (SHA-256) checksum, also confirmed on Hermes:

```text
73eb7d1f015efd3e31eacb7a375d882802e844a64e05783474ae9fb985eb0d06
```

A second scheduled run at 22:02:33 UTC, execution `pa37jvzp4o3n9ou37tww08ef`,
uploaded `pg-dump-receipts-1791583353.dmp` to the European Union object store. That
object was independently downloaded with the existing server-side storage
credentials and restored in the same isolated verifier. All 28 table counts,
639 rows, column definitions, constraints and indexes matched again. Its checksum:

```text
44614b05ba20edc960cc0b0779ee713fb24b8f1fef4b5fab4d4284122713a4ee
```

The transient retrieved files and scratch containers were removed. The durable
local, object-store, and Hermes copies remain private under their retention rules.

## Scope and limits

This protects the receipts database, including file references. Original receipt
files live in Storage Brain and are not bytes inside this dump. It does not prove
file-store recovery or authorize permanent object deletion. Shared contacts live
in a separate database with their own recovery procedure.

These dumps provide discrete recovery points. They do not implement continuous
write-ahead-log archiving or point-in-time recovery. Hermes and R2 provide independent copies. No object-lock retention or immutable
backup policy is configured; administrative compromise remains a separate risk.
Reassess the six-hour loss window when transaction volume or commercial exposure
changes.
