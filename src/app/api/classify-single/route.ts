import { NextRequest, NextResponse } from 'next/server';
import { CATEGORY_TO_KONTO, ZUORDNUNG_OPTIONS } from '@/lib/receipts-table';
import { classifyWithWebSearch } from '@/lib/web-search';

const CATEGORY_NAMES = Object.keys(CATEGORY_TO_KONTO);

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { ocrText, vendor, gross, date, userRules } = body as {
    ocrText?: string;
    vendor?: string;
    gross?: number;
    date?: string;
    items?: string[];
    userRules?: string;
  };

  if (!ocrText) {
    return NextResponse.json({ category: null, konto: null, confidence: 0, reasoning: 'No OCR text provided' });
  }

  try {
    const result = await classifyWithWebSearch({
      vendor: vendor ?? null,
      gross: gross ?? null,
      date: date ?? null,
      fullText: ocrText,
      categoryNames: CATEGORY_NAMES,
      categoryToKonto: CATEGORY_TO_KONTO,
      zuordnungOptions: ZUORDNUNG_OPTIONS,
      userRules: userRules || undefined,
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error('[classify-single] Classification failed:', err);
    return NextResponse.json({ category: null, konto: null, confidence: 0, reasoning: 'Classification failed' });
  }
}
