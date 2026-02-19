# Receipt OCR App

A Next.js application for uploading receipt images, extracting data via OCR, and managing receipts in a Notion-like table.

## Features

- **Receipt Upload** - Drag-and-drop or click to upload receipt images
- **OCR Processing** - Automatic text extraction via Storage Brain
- **Intelligent Field Extraction** - Automatically extracts vendor, amount, date, and category from OCR text using regex/heuristic parsing (supports US & European formats)
- **Notion-like Table** - Manage receipts with filtering, sorting, and inline editing
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

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Environment Variables

```env
# Required
STORAGE_BRAIN_API_KEY=sk_live_...

# Database (Cloudflare D1)
DATABASE_URL=...

# Auth (optional, for multi-user)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...
```

## Tech Stack

- **Framework**: [Next.js 14](https://nextjs.org/) (App Router)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **File Storage**: [@marlinjai/storage-brain-sdk](../storage-brain-sdk)
- **Data Table**: [@marlinjai/data-table-react](../data-table/packages/react)
- **Database**: Cloudflare D1
- **Auth**: Clerk (planned)

## Usage

### Uploading Receipts

1. Navigate to the home page
2. Drag and drop a receipt image (or click to browse)
3. Wait for upload and OCR processing
4. You'll be redirected to the dashboard

### Managing Receipts

- **Edit**: Click any cell to edit inline
- **Sort**: Click column headers to sort
- **Filter**: Use the filter bar to filter by vendor, date, category
- **Delete**: Select rows and click delete

## Documentation

- [Architecture](./docs/architecture.md) - System design and integrations

## Development

```bash
# Run development server
pnpm dev

# Build for production
pnpm build

# Run production server
pnpm start

# Type check
pnpm typecheck
```

## License

MIT
