#!/bin/sh
# The daily bank fetch, as the Coolify scheduled task runs it inside the app's
# container (docs/operations/bank-sync.md). A scheduled task is a command of its
# own and does not see the secrets the server loaded at start, so it loads them
# the same way (entrypoint.sh): the machine identity's client id and secret are
# in the container's environment, BANK_SYNC_SECRET comes from Infisical. The
# secret and the signature never leave this process; the output is the answer's
# status and counts only. Exits non-zero on anything but a success, so the
# scheduler shows a failed run.
set -e

PROJECT_ID="95d42533-3157-4b66-a49b-cc386ec1214d"
DOMAIN="https://infisical.lumitra.co"

INFISICAL_TOKEN=$(infisical login \
  --method=universal-auth \
  --client-id="$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID" \
  --client-secret="$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" \
  --domain "$DOMAIN" \
  --silent --plain)
export INFISICAL_TOKEN

exec infisical run --env=prod --projectId="$PROJECT_ID" --domain "$DOMAIN" -- node scripts/bank-sync-call.mjs
