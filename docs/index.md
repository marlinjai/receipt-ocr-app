---
title: Receipt OCR App
description: Next.js expense tracking with AI-powered receipt scanning
order: 0
---

# Receipt OCR App Documentation

This directory contains documentation for the Receipt OCR application.

## Contents

- [Architecture](./architecture.md) - System design and integrations

## Overview

The Receipt OCR App is a Next.js application that:

1. Allows users to upload receipt images
2. Extracts text and data via OCR (Storage Brain)
3. Displays receipts in a Notion-like table (Data Table)
4. Enables filtering, sorting, and editing of receipt data

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

## Key Features

- **Receipt Upload**: Drag-and-drop or click to upload
- **OCR Processing**: Automatic text extraction via Storage Brain
- **Data Table**: Notion-like interface for managing receipts
- **Filtering**: Filter by vendor, date, category
- **Sorting**: Sort by amount, date, etc.

## Related Packages

- [`@marlinjai/storage-brain-sdk`](../../storage-brain-sdk) - File storage and OCR
- [`@marlinjai/data-table-react`](../../data-table/packages/react) - Table UI components
