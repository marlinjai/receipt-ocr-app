---
title: Getting Started
description: Set up the Receipt OCR App locally
order: 1
icon: rocket
---

# Getting Started

This guide walks you through setting up the Receipt OCR App for local development.

## Prerequisites

- **Node.js** 18+ installed
- **pnpm** package manager
- **Storage Brain API key** -- for file uploads and OCR processing
- **Data Brain API key** -- for structured data storage

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
# Storage Brain -- handles file uploads and OCR
STORAGE_BRAIN_API_KEY=sk_live_your_key_here

# Data Brain -- handles structured data (receipts, categories, etc.)
DATA_BRAIN_API_KEY=db_live_your_key_here
DATA_BRAIN_URL=https://data-brain.workers.dev
```

## Run the Dev Server

```bash
pnpm dev
```

The app will be available at [http://localhost:3000](http://localhost:3000).

## Upload Your First Receipt

1. Open the app in your browser
2. Drag and drop a receipt image onto the upload zone (or click to browse)
3. Wait for the upload and OCR processing to complete
4. You will be redirected to the dashboard automatically

## View in Dashboard

The dashboard at `/dashboard` displays all your receipts in a Notion-like table. From here you can:

- **Sort** by any column (amount, date, vendor)
- **Filter** by vendor, date range, or category
- **Edit** cells inline -- click any cell to modify its value
- **Add rows** manually for receipts you want to enter by hand
