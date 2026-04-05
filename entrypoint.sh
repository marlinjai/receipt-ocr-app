#!/bin/sh
set -e

PROJECT_ID="95d42533-3157-4b66-a49b-cc386ec1214d"
DOMAIN="https://infisical.lumitra.co"

# Authenticate with Infisical via machine identity (Universal Auth)
INFISICAL_TOKEN=$(infisical login \
  --method=universal-auth \
  --client-id="$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID" \
  --client-secret="$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" \
  --domain "$DOMAIN" \
  --silent --plain)

# Inject secrets and start the app
# NEXT_PUBLIC_* are baked in at build time — runtime injection is for server-side secrets only
exec infisical run \
  --env=prod \
  --projectId="$PROJECT_ID" \
  --domain "$DOMAIN" \
  --token "$INFISICAL_TOKEN" \
  -- node server.js
