'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import ReceiptUploader from '@/components/ReceiptUploader';
import type { UploadResult } from '@/components/ReceiptUploader';
import { extractReceiptFields } from '@/lib/extract-receipt-fields';
import { dbAdapter, getReceiptsTableId, WORKSPACE_ID } from '@/lib/receipts-table';
import type { CellValue } from '@marlinjai/data-table-core';

export default function UploadPage() {
  const router = useRouter();

  const handleUploadComplete = useCallback(async (result: UploadResult) => {
    const { file, ocrResult } = result;

    // Get table ID and columns
    const tableId = await getReceiptsTableId();
    const columns = await dbAdapter.getColumns(tableId);

    // Extract fields from OCR result
    const extracted = ocrResult ? extractReceiptFields(ocrResult) : null;

    // Load select options for Status and Category columns
    const statusCol = columns.find((c) => c.name === 'Status');
    const categoryCol = columns.find((c) => c.name === 'Category');

    const [statusOpts, categoryOpts] = await Promise.all([
      statusCol ? dbAdapter.getSelectOptions(statusCol.id) : Promise.resolve([]),
      categoryCol ? dbAdapter.getSelectOptions(categoryCol.id) : Promise.resolve([]),
    ]);

    const statusValue = ocrResult?.fullText
      ? statusOpts.find((o) => o.name === 'Processed')?.id
      : statusOpts.find((o) => o.name === 'Pending')?.id;

    const categoryValue = extracted?.category
      ? categoryOpts.find((o) => o.name === extracted.category)?.id ?? null
      : null;

    // Build cells record
    const cells: Record<string, CellValue> = {};
    for (const col of columns) {
      switch (col.name) {
        case 'Name':
          cells[col.id] = extracted?.name || file.originalName;
          break;
        case 'Vendor':
          cells[col.id] = extracted?.vendor ?? null;
          break;
        case 'Gross':
          cells[col.id] = extracted?.gross ?? null;
          break;
        case 'Net':
          cells[col.id] = extracted?.net ?? null;
          break;
        case 'Tax Rate':
          cells[col.id] = extracted?.taxRate ?? null;
          break;
        case 'Date':
          cells[col.id] = extracted?.date ?? null;
          break;
        case 'Category':
          cells[col.id] = categoryValue;
          break;
        case 'Konto':
          cells[col.id] = extracted?.konto ?? null;
          break;
        case 'Status':
          cells[col.id] = statusValue ?? '';
          break;
        case 'Confidence':
          cells[col.id] = ocrResult?.confidence ? Math.round(ocrResult.confidence * 100) : 0;
          break;
        case 'Receipt Image':
          cells[col.id] = file.id ? `/api/files/${file.id}` : '';
          break;
        case 'OCR Text':
          cells[col.id] = ocrResult?.fullText ?? '';
          break;
      }
    }

    // Write directly to Data Brain
    await dbAdapter.createRow({ tableId, cells });

    // Navigate to dashboard — row is already persisted
    router.push('/app/dashboard');
  }, [router]);

  return (
    <main className="relative z-10 min-h-screen flex flex-col items-center justify-center px-4 py-16">
      <div className="w-full max-w-lg mx-auto">
        {/* Header */}
        <div className="text-center mb-10">
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium tracking-wide uppercase mb-6"
            style={{ background: 'var(--accent-muted)', color: 'var(--accent)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
            AI-Powered OCR
          </div>

          <h1
            className="text-4xl font-bold tracking-tight mb-3"
            style={{ color: 'var(--foreground)' }}
          >
            Receipt OCR
          </h1>

          <p
            className="text-base leading-relaxed max-w-md mx-auto"
            style={{ color: 'var(--muted)' }}
          >
            Upload receipts and invoices to instantly extract text and structured data.
            Powered by{' '}
            <a
              href="https://github.com/marlinjai/storage-brain"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors"
              style={{ color: 'var(--accent)', textDecoration: 'none' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent-hover)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--accent)')}
            >
              Storage Brain
            </a>.
          </p>
        </div>

        {/* Upload */}
        <ReceiptUploader onUploadComplete={handleUploadComplete} />

        {/* Dashboard link */}
        <div className="text-center mt-8">
          <Link
            href="/app/dashboard"
            className="glass-panel inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 hover:border-[var(--accent)] hover:text-[var(--accent)]"
            style={{
              color: 'var(--foreground)',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" />
              <rect x="14" y="3" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" />
              <rect x="3" y="14" width="7" height="7" />
            </svg>
            View Dashboard
          </Link>
        </div>

        {/* Footer */}
        <footer className="mt-16 text-center text-xs" style={{ color: 'var(--muted)' }}>
          <p>
            Built with{' '}
            <a
              href="https://www.npmjs.com/package/@marlinjai/storage-brain-sdk"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors"
              style={{ color: 'var(--muted)', textDecoration: 'underline', textUnderlineOffset: '2px' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--muted)')}
            >
              @marlinjai/storage-brain-sdk
            </a>
          </p>
        </footer>
      </div>
    </main>
  );
}
