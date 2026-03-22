# Receipt OCR App

A Next.js application for uploading receipt images, extracting data via OCR, and managing receipts in a Notion-like table.

## Features

- **Receipt Upload** - Drag-and-drop or click to upload receipt images
- **OCR Processing** - Automatic text extraction via Google Cloud Vision API
- **AI Classification** - AI-powered field extraction and expense categorization via OpenRouter
- **AI Chat Sidebar** - Query expenses using natural language with tool_use support
- **Notion-like Table** - Manage receipts with filtering, sorting, and inline editing
- **SKR03 Accounting** - German accounting standard category mapping
- **Category Management** - Organize receipts by expense category

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
# Storage Brain (file uploads)
NEXT_PUBLIC_STORAGE_BRAIN_API_KEY=sk_live_...
NEXT_PUBLIC_STORAGE_BRAIN_URL=https://storage-brain-api.marlin-pohl.workers.dev

# Data Brain (archived 2026-03-22 — migrate to adapter-d1; these vars unused after migration)
# NEXT_PUBLIC_DATA_BRAIN_API_KEY=sk_live_...
# NEXT_PUBLIC_DATA_BRAIN_URL=https://data-brain-api.marlin-pohl.workers.dev

# OCR
GOOGLE_CLOUD_VISION_API_KEY=...

# AI (classification + chat)
OPENROUTER_API_KEY=sk-or-...
```

## Tech Stack

- **Framework**: [Next.js 16](https://nextjs.org/) (App Router)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **File Storage**: [@marlinjai/storage-brain-sdk](https://www.npmjs.com/package/@marlinjai/storage-brain-sdk)
- **Data Table**: [@marlinjai/data-table-react](../data-table/packages/react)
- **Database**: Pending migration to `@marlinjai/data-table-adapter-d1` directly (Data Brain archived 2026-03-22)
- **Deployment**: Cloudflare Pages via @opennextjs/cloudflare

## Usage

### Uploading Receipts

1. Navigate to `/app`
2. Drag and drop a receipt image (or click to browse)
3. Wait for upload and OCR processing
4. You'll be redirected to the dashboard

### Managing Receipts

- **Edit**: Click any cell to edit inline
- **Sort**: Click column headers to sort
- **Filter**: Use the filter bar to filter by vendor, date, category
- **Delete**: Select rows and click delete

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
```

## License

MIT
