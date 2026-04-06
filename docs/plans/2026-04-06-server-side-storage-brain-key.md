---
title: Move Storage Brain API Key Server-Side
type: plan
status: completed
summary: Remove NEXT_PUBLIC_ prefix from Storage Brain API key, move all SDK usage to server API routes so the key never reaches the client browser bundle.
tags: [security, storage-brain, receipt-ocr]
date: 2026-04-06
---

# Move Storage Brain API Key Server-Side

## Problem

The Storage Brain API key (`NEXT_PUBLIC_STORAGE_BRAIN_API_KEY`) is baked into the client JS bundle via the `NEXT_PUBLIC_` prefix. Anyone can extract it from the browser. This is a tenant-level key that authorizes uploads and file access — it should never leave the server.

## How It Works Today

```
Client (ReceiptUploader.tsx — 'use client')
  → calls getStorageClient() from src/lib/storage.ts
  → SDK.upload(file):
      1. POST /api/v1/upload/request (needs API key) → gets presigned URL
      2. PUT presigned URL (uploads file bytes directly to R2 — no key needed)
      3. GET /api/v1/files/:id (needs API key) → returns FileInfo
  → then calls /api/ocr with fileId
```

The key is exposed because steps 1 and 3 happen client-side via the SDK.

## Solution

Create a server-side `/api/upload` route that proxies the authenticated steps. The client only sees the presigned URL (which is time-limited and unauthenticated).

### New Flow

```
Client (ReceiptUploader.tsx)
  → POST /api/upload/request { fileName, fileType, fileSize, context, tags }
      Server: SDK calls Storage Brain handshake, returns { presignedUrl, fileId }
  → PUT presignedUrl (client uploads directly to R2 — unchanged, no key needed)
  → GET /api/upload/complete/:fileId
      Server: SDK calls getFile(), returns FileInfo
  → POST /api/ocr { fileId } (unchanged)
```

### Changes Required

| File | Change |
|------|--------|
| **NEW** `src/app/api/upload/request/route.ts` | Server route: calls `storage.requestUpload()` via SDK, returns `{ presignedUrl, fileId }` |
| **NEW** `src/app/api/upload/complete/[fileId]/route.ts` | Server route: calls `storage.getFile(fileId)`, returns `FileInfo` |
| `src/lib/storage.ts` | Remove `NEXT_PUBLIC_` prefix → `STORAGE_BRAIN_API_KEY`. Add a note that this module is server-only. |
| `src/components/ReceiptUploader.tsx` | Replace `getStorageClient().upload()` with fetch calls to new API routes + direct R2 upload |
| `Dockerfile` | Remove `ARG NEXT_PUBLIC_STORAGE_BRAIN_API_KEY` build-arg (key now injected at runtime via Infisical) |
| `.github/workflows/deploy.yml` | Remove `NEXT_PUBLIC_STORAGE_BRAIN_API_KEY` build-arg |
| `.env.example` | Rename `NEXT_PUBLIC_STORAGE_BRAIN_API_KEY` → `STORAGE_BRAIN_API_KEY` |
| `src/app/api/ocr/route.ts` | Rename env var reference |
| `src/app/api/files/[fileId]/route.ts` | Rename env var reference |
| `wrangler.jsonc` | Rename key (legacy, but keep consistent) |
| `README.md`, `docs/` | Update env var name in documentation |

### What Stays the Same

- File bytes still upload directly to R2 via presigned URL (no server proxy for large files)
- `NEXT_PUBLIC_STORAGE_BRAIN_URL` stays public — it's just an endpoint, not a secret
- OCR flow is unchanged
- `STORAGE_BRAIN_API_KEY` gets injected at runtime via Infisical `entrypoint.sh` (already set up)

### Progress Tracking for Upload

The SDK currently uses `XMLHttpRequest` for browser upload progress. Since the client will still PUT directly to the presigned URL, we replicate this in `ReceiptUploader.tsx` using XHR directly (same approach the SDK uses internally).

## Migration

1. Rename key in Infisical: `NEXT_PUBLIC_STORAGE_BRAIN_API_KEY` → `STORAGE_BRAIN_API_KEY`
2. Deploy new code
3. Remove `STORAGE_BRAIN_API_KEY` GitHub Actions secret (no longer needed as build-arg)
