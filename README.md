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
# Storage Brain (file uploads to Cloudflare R2)
NEXT_PUBLIC_STORAGE_BRAIN_API_KEY=sk_live_...
NEXT_PUBLIC_STORAGE_BRAIN_URL=https://storage-brain-api.marlin-pohl.workers.dev

# OCR
GOOGLE_CLOUD_VISION_API_KEY=...

# AI (classification + chat)
OPENROUTER_API_KEY=sk-or-...
```

## Tech Stack

- **Framework**: [Next.js 16](https://nextjs.org/) (App Router)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **Database**: [@marlinjai/data-table-adapter-d1](https://www.npmjs.com/package/@marlinjai/data-table-adapter-d1) (Cloudflare D1)
- **File Storage**: [@marlinjai/storage-brain-sdk](https://www.npmjs.com/package/@marlinjai/storage-brain-sdk) (Cloudflare R2)
- **Data Table**: [@marlinjai/data-table-react](../data-table/packages/react)
- **Deployment**: Cloudflare Workers via @opennextjs/cloudflare

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
