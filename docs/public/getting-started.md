---
title: Getting Started
description: Set up the Receipt OCR App locally
order: 2
icon: "🚀"
summary: Setup guide for running the Receipt OCR App locally, covering environment variables, dependencies, and development server configuration.
type: documentation
tags: [receipt-ocr, getting-started, setup, local-development]
projects: [receipt-ocr-app]
---

# Getting Started

This guide walks you through setting up the Receipt OCR App for local development.

## Prerequisites

- **Node.js** 18+ installed
- **pnpm** package manager
- **Storage Brain API key** -- for file uploads to Cloudflare R2
- **Google Cloud Vision API key** -- for OCR text extraction
- **OpenRouter API key** -- for AI classification and chat

## Clone and Install

```bash
# Clone the ERP suite (if not already)
git clone https://github.com/marlinjai/ERP-suite.git
cd ERP-suite/projects/receipt-ocr-app

# Install dependencies
pnpm install
```

## Environment Setup

Create a `.env.local` file in the project root:

```env
# Storage Brain -- file uploads to Cloudflare R2
NEXT_PUBLIC_STORAGE_BRAIN_API_KEY=sk_live_your_key_here
NEXT_PUBLIC_STORAGE_BRAIN_URL=https://storage-brain-api.marlin-pohl.workers.dev

# Google Cloud Vision -- OCR for images and PDFs
GOOGLE_CLOUD_VISION_API_KEY=AIza_your_key_here

# OpenRouter -- AI classification and chat sidebar
OPENROUTER_API_KEY=sk-or-v1-your_key_here

# Optional: the model of the chat sidebar (default anthropic/claude-sonnet-4.6)
# AI_MODEL=anthropic/claude-sonnet-4.6
# Optional: the model that reads a receipt. It is given the page itself (an image
# or PDF pages), so it must accept image and file input. Default
# anthropic/claude-haiku-5.5; falls back to AI_MODEL when that is set.
# AI_CLASSIFY_MODEL=anthropic/claude-haiku-5.5
```

Database connectivity uses the Cloudflare D1 binding (`DB`) configured in `wrangler.jsonc` -- no environment variables needed for the database.

## Run the Dev Server

```bash
pnpm dev
```

The app will be available at [http://localhost:3004](http://localhost:3004).

## Upload Your First Receipt

1. Open the app in your browser
2. Drag and drop one or more receipt images or PDFs onto the upload zone (or click to browse and select multiple files)
3. Each file goes through the pipeline sequentially: upload to Storage Brain, OCR via Google Cloud Vision, AI classification, and saving to D1. Per-file progress indicators show the current phase.
4. Fields like vendor, amounts, date, category, and SKR03 konto are extracted automatically
5. You will be redirected to the dashboard once complete

## View in Dashboard

The dashboard at `/dashboard` displays all your receipts with 4 switchable views:

- **Table** -- grouped by Category (default), with column management and inline editing
- **By Konto** -- grouped by SKR03 account number
- **Board** -- Kanban-style board grouped by Status (Pending / Processed / Rejected)
- **Calendar** -- date-based view

## AI Features

### Classify Receipts
On upload, one language model call reads and classifies the receipt. It is given the page itself (the image, or the PDF pages) next to the recognized text, and answers the SKR03 category, konto and zuordnung (assignment context) as well as the invoice date, total, currency, net and tax lines. Its figures are a second reading: the invoice's own arithmetic and the recognized text check them, and what cannot be settled is put on the review list instead of being stored silently. A receipt that is already stored can be read again from its detail panel ("Seite neu lesen"). You can define custom classification rules that are stored in your browser and included in AI prompts.

### Chat Sidebar
Click the chat icon on the dashboard to open the AI chat sidebar. You can ask the assistant to:

- Read and summarize receipt data
- Classify unprocessed receipts
- Update fields across multiple rows (bulk operations)
- Create or delete rows

Read-only operations execute automatically. Write operations require your explicit approval before they run.
