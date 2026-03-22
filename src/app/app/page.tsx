'use client';

import { useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import ReceiptUploader from '@/components/ReceiptUploader';
import type { UploadResult } from '@/components/ReceiptUploader';
import { extractReceiptFields } from '@/lib/extract-receipt-fields';
import { dbAdapter, getReceiptsTableId, WORKSPACE_ID } from '@/lib/receipts-table';
import type { CellValue } from '@marlinjai/data-table-core';

/** Data needed to retry classification without re-uploading */
interface ClassificationContext {
  file: UploadResult['file'];
  ocrResult: UploadResult['ocrResult'];
  extracted: ReturnType<typeof extractReceiptFields> | null;
}

export default function UploadPage() {
  const router = useRouter();
  const lastContextRef = useRef<ClassificationContext | null>(null);

  /** Attempt AI classification; returns result or null on failure (+ error message) */
  const classifyReceipt = useCallback(async (
    extracted: ReturnType<typeof extractReceiptFields>,
    fullText: string,
  ): Promise<{ aiCategory: string | null; aiKonto: string | null; aiZuordnung: string | null; error: string | null }> => {
    try {
      const classifyRes = await fetch('/api/classify-single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ocrText: fullText,
          vendor: extracted.vendor,
          gross: extracted.gross,
          date: extracted.date,
        }),
      });
      if (classifyRes.ok) {
        const ai = await classifyRes.json();
        return {
          aiCategory: ai.category ?? null,
          aiKonto: ai.konto ?? null,
          aiZuordnung: ai.zuordnung ?? null,
          error: null,
        };
      }
      const errText = await classifyRes.text().catch(() => '');
      return { aiCategory: null, aiKonto: null, aiZuordnung: null, error: `Classification failed (${classifyRes.status})${errText ? ': ' + errText : ''}` };
    } catch (err) {
      return {
        aiCategory: null,
        aiKonto: null,
        aiZuordnung: null,
        error: err instanceof Error ? err.message : 'Classification request failed',
      };
    }
  }, []);

  /** Build cells and save the row */
  const saveRow = useCallback(async (
    file: UploadResult['file'],
    ocrResult: UploadResult['ocrResult'],
    extracted: ReturnType<typeof extractReceiptFields> | null,
    aiCategory: string | null,
    aiKonto: string | null,
    aiZuordnung: string | null,
    classificationFailed: boolean,
  ) => {
    const tableId = await getReceiptsTableId();
    const columns = await dbAdapter.getColumns(tableId);

    const statusCol = columns.find((c) => c.name === 'Status');
    const categoryCol = columns.find((c) => c.name === 'Category');
    const zuordnungCol = columns.find((c) => c.name === 'Zuordnung');

    const [statusOpts, categoryOpts, zuordnungOpts] = await Promise.all([
      statusCol ? dbAdapter.getSelectOptions(statusCol.id) : Promise.resolve([]),
      categoryCol ? dbAdapter.getSelectOptions(categoryCol.id) : Promise.resolve([]),
      zuordnungCol ? dbAdapter.getSelectOptions(zuordnungCol.id) : Promise.resolve([]),
    ]);

    // If classification failed but OCR succeeded, mark as Pending
    const statusValue = classificationFailed
      ? statusOpts.find((o) => o.name === 'Pending')?.id
      : ocrResult?.fullText
        ? statusOpts.find((o) => o.name === 'Processed')?.id
        : statusOpts.find((o) => o.name === 'Pending')?.id;

    const finalCategory = aiCategory || extracted?.category;
    const categoryValue = finalCategory
      ? categoryOpts.find((o) => o.name === finalCategory)?.id ?? null
      : null;

    const finalKonto = aiKonto || extracted?.konto;

    const zuordnungValue = aiZuordnung
      ? zuordnungOpts.find((o) => o.name === aiZuordnung)?.id ?? null
      : null;

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
          cells[col.id] = finalKonto ?? null;
          break;
        case 'Zuordnung':
          cells[col.id] = zuordnungValue;
          break;
        case 'Status':
          cells[col.id] = statusValue ?? '';
          break;
        case 'Confidence':
          cells[col.id] = ocrResult?.confidence ? Math.round(ocrResult.confidence * 100) : 0;
          break;
        case 'Receipt Image': {
          const isPdf = (file.fileType ?? '').includes('pdf') || (file.originalName ?? '').toLowerCase().endsWith('.pdf');
          cells[col.id] = file.id
            ? isPdf ? `/api/files/${file.id}/thumbnail` : `/api/files/${file.id}`
            : '';
          break;
        }
        case 'OCR Text':
          cells[col.id] = ocrResult?.fullText ?? '';
          break;
      }
    }

    await dbAdapter.createRow({ tableId, cells });
  }, []);

  const handleUploadComplete = useCallback(async (result: UploadResult) => {
    const { file, ocrResult } = result;
    const extracted = ocrResult ? extractReceiptFields(ocrResult) : null;

    // Store context for potential retry
    lastContextRef.current = { file, ocrResult, extracted };

    let aiCategory: string | null = null;
    let aiKonto: string | null = null;
    let aiZuordnung: string | null = null;
    let classificationFailed = false;
    let classificationError: string | null = null;

    // Try AI classification if we have OCR text
    if (extracted && ocrResult?.fullText) {
      const classResult = await classifyReceipt(extracted, ocrResult.fullText);
      aiCategory = classResult.aiCategory;
      aiKonto = classResult.aiKonto;
      aiZuordnung = classResult.aiZuordnung;
      if (classResult.error) {
        classificationFailed = true;
        classificationError = classResult.error;
      }
    }

    // Save the row even if classification failed (partial result handling)
    await saveRow(file, ocrResult, extracted, aiCategory, aiKonto, aiZuordnung, classificationFailed);

    if (classificationFailed) {
      // Throw so ReceiptUploader can show the error with retry
      throw new Error(`AI classification failed: ${classificationError}. Row saved with OCR data and Pending status.`);
    }

    router.push('/app/dashboard');
  }, [router, classifyReceipt, saveRow]);

  /** Retry just the classification step, then navigate */
  const handleRetryClassification = useCallback(async () => {
    const ctx = lastContextRef.current;
    if (!ctx || !ctx.extracted || !ctx.ocrResult?.fullText) return;

    const classResult = await classifyReceipt(ctx.extracted, ctx.ocrResult.fullText);
    if (classResult.error) {
      throw new Error(`AI classification retry failed: ${classResult.error}`);
    }

    // Classification succeeded — save a new row with full data
    await saveRow(
      ctx.file, ctx.ocrResult, ctx.extracted,
      classResult.aiCategory, classResult.aiKonto, classResult.aiZuordnung,
      false,
    );

    router.push('/app/dashboard');
  }, [router, classifyReceipt, saveRow]);

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
        <ReceiptUploader
          onUploadComplete={handleUploadComplete}
          onRetryClassification={handleRetryClassification}
        />

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
