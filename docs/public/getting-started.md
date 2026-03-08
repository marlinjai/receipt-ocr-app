---
title: Getting Started
description: Set up the Receipt OCR App locally
order: 2
icon: "🚀"
summary: Setup guide for running the Receipt OCR App locally, covering environment variables, dependencies, and development server configuration.
category: documentation
tags: [receipt-ocr, getting-started, setup, local-development]
projects: [receipt-ocr-app]
status: active
---

# Getting Started

This guide walks you through setting up the Receipt OCR App for local development.

## Prerequisites

- **Node.js** 18+ installed
- **pnpm** package manager
- **Storage Brain API key** -- for file uploads to Cloudflare R2
- **Data Brain API key** -- for structured data storage
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

# Data Brain -- structured data (receipts table, columns, rows)
NEXT_PUBLIC_DATA_BRAIN_API_KEY=db_live_your_key_here
NEXT_PUBLIC_DATA_BRAIN_URL=https://data-brain.workers.dev

# Google Cloud Vision -- OCR for images and PDFs
GOOGLE_CLOUD_VISION_API_KEY=AIza_your_key_here

# OpenRouter -- AI classification and chat sidebar
OPENROUTER_API_KEY=sk-or-v1-your_key_here

# Optional: override the default AI model (anthropic/claude-sonnet-4-20250514)
# AI_MODEL=anthropic/claude-sonnet-4-20250514
# AI_CLASSIFY_MODEL=anthropic/claude-sonnet-4-20250514
```

## Run the Dev Server

```bash
pnpm dev
```

The app will be available at [http://localhost:3004](http://localhost:3004).

## Upload Your First Receipt

1. Open the app in your browser
2. Drag and drop a receipt image or PDF onto the upload zone (or click to browse)
3. The upload goes through three phases: uploading to Storage Brain, OCR via Google Cloud Vision, and saving extracted fields to Data Brain
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
After uploading, receipts can be classified by AI. The classification endpoint uses the OCR text and vendor to determine the SKR03 category, konto, and zuordnung (assignment context). You can define custom classification rules that are stored in your browser and included in AI prompts.

### Chat Sidebar
Click the chat icon on the dashboard to open the AI chat sidebar. You can ask the assistant to:

- Read and summarize receipt data
- Classify unprocessed receipts
- Update fields across multiple rows (bulk operations)
- Create or delete rows

Read-only operations execute automatically. Write operations require your explicit approval before they run.
