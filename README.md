# Receipt OCR App

A Next.js application for uploading receipt images, extracting data via OCR, and managing receipts in an interactive dashboard.

## Features

- **Multi-Receipt Batch Upload** - Drag-and-drop or click to upload multiple receipt images at once with queue UI, per-file progress indicators, and sequential processing (failed files don't block others)
- **OCR Processing** - Automatic text extraction via Google Cloud Vision API
- **AI Classification** - AI-powered field extraction and expense categorization via OpenRouter (category, Konto/SKR03, Zuordnung)
- **AI Chat Sidebar** - Query expenses using natural language with tool_use support
- **Interactive Dashboard** - Manage receipts with filtering, sorting, inline editing, and 4 switchable views (Table, By Konto, Board, Calendar)
- **SKR03 Accounting** - German accounting standard category mapping
- **Category Management** - Organize receipts by expense category
- **Business-Meal Register (Bewirtungsverzeichnis)** - Guests, occasion, place, tip and host per meal, a queue of incomplete meals, and a per-year register with the 70 percent deductible amount, exported as CSV or PDF
- **Duplicate Detection and Page Split** - The same file is caught before upload, a receipt photographed twice gets a warning, and a multi-page scan can be split into one receipt per page

## Quick Start

```bash
# Install dependencies
pnpm install

# Set up environment variables
cp .env.example .env.local
# Edit .env.local with your API keys

# Run development server
pnpm dev
```

Open [http://localhost:3004](http://localhost:3004) in your browser.

## Environment Variables

```env
# Database (PostgreSQL)
DATABASE_URL=postgresql://...

# Storage Brain (file uploads)
STORAGE_BRAIN_API_KEY=sk_live_...
NEXT_PUBLIC_STORAGE_BRAIN_URL=https://storage-brain-api.marlin-pohl.workers.dev

# OCR
GOOGLE_CLOUD_VISION_API_KEY=...

# AI (classification + chat)
OPENROUTER_API_KEY=sk-or-...

# Auth (auth-brain multi-tenant integration)
# AUTH_BRAIN_URL defaults to https://auth.lumitra.co
OPENFGA_API_URL=...
OPENFGA_STORE_ID=...
OPENFGA_AUTHORIZATION_MODEL_ID=...
OPENFGA_API_TOKEN=...
SERVICE_TOKEN=...            # machine bearer for /api/* (>= 32 chars)
```

## Authentication

The app is a relying party of [auth-brain](https://auth.lumitra.co) (shared `lumitra_session` cookie on `.lumitra.co`). Access = one of your companies (tenants) holds the `receipts` app grant; the openable workspaces are then every workspace owned by a granted company (Lola Stories, marlinjai, Lumitra). All data is partitioned by the active workspace's UUID (`dt_tables.workspace_id`), and every row additionally carries the owning company on `auth_tenant_id`, so a row is attributable to exactly one company without asking auth-brain. The company follows the WORKSPACE, not the session default: those two legitimately differ when the active workspace belongs to a company other than the session's active one. The switcher in the header changes the active company (validated `receipts_ws` cookie). Mutations additionally pass fail-closed OpenFGA checks (`@marlinjai/auth-brain-nextjs`).

**Local dev bypasses auth by design:** set `AUTH_DEV_USER_EMAIL` (dev env in Infisical). The bypass only works with `NODE_ENV=development` and scopes data to the local `receipt-ocr` workspace (`AUTH_DEV_WORKSPACE_ID` to override). Machine callers hit `/api/*` with `Authorization: Bearer $SERVICE_TOKEN`; `/api/health` stays public.

## Tech Stack

- **Framework**: [Next.js 16](https://nextjs.org/) (App Router)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **Database**: PostgreSQL via [Prisma](https://www.prisma.io/), with [@marlinjai/data-table-adapter-prisma](https://www.npmjs.com/package/@marlinjai/data-table-adapter-prisma) backing the dynamic `dt_*` tables
- **File Storage**: [@marlinjai/storage-brain-sdk](https://www.npmjs.com/package/@marlinjai/storage-brain-sdk)
- **Data Table**: [@marlinjai/data-table-react](../data-table/packages/react)
- **Deployment**: Docker image (see `Dockerfile`), secrets injected at runtime by the Infisical CLI

> The app ran on Cloudflare D1 and Workers via `@opennextjs/cloudflare` earlier in
> its life, and this section described that stack long after it was retired. The
> remaining `wrangler` usage is the DOCS site only (`.github/workflows/deploy-docs.yml`
> deploys to Cloudflare Pages); the application itself no longer touches Cloudflare.

## Usage

### Uploading Receipts

1. Navigate to `/app`
2. Drag and drop one or more receipt images (or click to browse and select multiple files)
3. Each file is processed sequentially through the upload, OCR, classify, and save pipeline with per-file progress indicators
4. Failed files do not block the remaining queue
5. Once all files complete, you'll be redirected to the dashboard

### Managing Receipts

- **Edit**: Click any cell to edit inline
- **Sort**: Click column headers to sort
- **Filter**: Use the filter bar to filter by vendor, date, category
- **Delete**: Select rows and click delete

### Business meals

1. Open `/app/meals` (the "Bewirtung" link on the dashboard shows how many meals still lack facts)
2. "Unvollständig" lists every receipt categorised as Bewirtung that lacks guests, occasion, place or host. Pick guests from the contact list (typing a new name creates the contact), name the occasion, save. A half-filled entry stays in the list
3. "Verzeichnis" asks once whether the business is a small business under section 19 of the value-added tax act, then shows the year's register with totals and exports it as CSV or PDF
4. For a stack of scanned receipts in one PDF, tick "One receipt per page" on the upload page before dropping the file

### On the phone

1. Open the app in the phone's browser and add it to the home screen
2. "Foto aufnehmen" opens the camera. The photo is scaled, uploaded, read and filed. For a business meal the app asks for guests and occasion right away; "Später" leaves it in the queue of open meals
3. A photo that was read badly can be retaken: the new photo replaces the old one on the same receipt
4. Without a connection the photo is kept on the phone and sent when the connection is back; the screen shows how many are waiting. If the app cannot be reached at all, a small offline page still takes photos
5. On Android the installed app also appears in the share sheet for images and PDFs. iOS does not offer this to web apps

The service worker (`public/sw.js`) never caches application code. To withdraw it, set `DISABLE_SERVICE_WORKER=1` and restart: every browser unregisters it on its next page load.

The rules (what counts as complete, how the deductible amount is computed) live in one module, `src/lib/meals/rules.ts`, and the plan is `docs/plans/2026-10-06-meal-register-and-phone-capture.md`.

## Documentation

- [Architecture](./docs/public/architecture.md) - System design and integrations

## Development

```bash
# Run development server
pnpm dev

# Build for production
pnpm build

# Run production server
pnpm start

# Unit and component tests
pnpm test

# Database-backed tests: need a throwaway local Postgres with the migrations applied
DATABASE_URL=postgresql://... pnpm prisma migrate deploy
TEST_DATABASE_URL=postgresql://... pnpm test:db
```

## License

MIT
