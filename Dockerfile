FROM node:22-alpine AS base
RUN corepack enable pnpm

# --- Dependencies ---
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma/
RUN pnpm install --frozen-lockfile
RUN pnpm prisma generate

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
    else \
      echo "ERROR: server.js not found in standalone output" && find .next/standalone -name server.js && exit 1; \
    fi

# --- Runtime ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
