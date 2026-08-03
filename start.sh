#!/bin/sh
# Runs under `infisical run` (DATABASE_URL injected): apply schema migrations,
# then start the server. Fails LOUDLY (container exit) if the schema can't be
# brought current — serving P2021s would be worse.
set -e

SCHEMA="prisma/schema.prisma"

if ! prisma migrate deploy --schema "$SCHEMA"; then
  # One-time baseline path: prod predates deploy-time migrations, so its
  # dt_*/fx tables exist WITHOUT a _prisma_migrations ledger and deploy fails
  # (P3005 database-not-empty). Mark the pre-existing migrations as applied,
  # then retry. If the retry fails too (a genuinely broken new migration),
  # the `set -e` aborts the boot.
  echo "migrate deploy failed — attempting one-time baseline of pre-existing schema"
  prisma migrate resolve --schema "$SCHEMA" --applied 0001_init || true
  prisma migrate resolve --schema "$SCHEMA" --applied 0002_add_fx_rate_cache || true
  prisma migrate deploy --schema "$SCHEMA"
fi

# One-shot data migration (2026-08-03): Receipt Image url column → native
# file column. Idempotent (no-ops once converted); non-fatal so a hiccup
# degrades to url-cell display instead of a boot loop. Remove after prod
# logs confirm the conversion.
node scripts/migrate-receipt-image-to-file-column.mjs || echo "[migrate-file-column] non-fatal failure — see logs above"

exec node server.js
