FROM infisical/cli:0.43.69 AS infisical

FROM node:22-alpine AS base
RUN corepack enable pnpm

# --- Dependencies ---
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma/
RUN pnpm install --frozen-lockfile
RUN pnpm prisma generate

# --- Migrator (used by docker-compose for running migrations) ---
FROM deps AS migrator
CMD ["pnpm", "prisma", "migrate", "deploy"]

# --- Build ---
FROM base AS builder
WORKDIR /app

# NEXT_PUBLIC_ vars are inlined into the client bundle at build time
ARG NEXT_PUBLIC_STORAGE_BRAIN_URL
ARG NEXT_PUBLIC_STORAGE_BRAIN_API_KEY

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# Normalize standalone output path — may be nested in workspace builds
RUN if [ -f .next/standalone/server.js ]; then \
      echo "Standalone at root"; \
    elif [ -f .next/standalone/projects/receipt-ocr-app/server.js ]; then \
      echo "Standalone nested — flattening"; \
      mv .next/standalone/projects/receipt-ocr-app .next/standalone-app; \
      cp -r .next/standalone/node_modules .next/standalone-app/node_modules 2>/dev/null || true; \
      rm -rf .next/standalone; \
      mv .next/standalone-app .next/standalone; \
    fi

# --- Runtime ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Infisical CLI from official image (pinned version, no curl|bash)
COPY --from=infisical /bin/infisical /usr/local/bin/infisical
# curl for healthcheck
RUN apk add --no-cache curl

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --chown=nextjs:nodejs entrypoint.sh ./entrypoint.sh

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["sh", "entrypoint.sh"]
