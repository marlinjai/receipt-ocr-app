import { NextRequest, NextResponse } from 'next/server';
import { getAiClient, getClassifyModel } from '@/lib/ai-client';
import { CATEGORY_TO_KONTO, ZUORDNUNG_OPTIONS } from '@/lib/receipts-table';

const CATEGORY_NAMES = Object.keys(CATEGORY_TO_KONTO);

export async function POST(request: NextRequest) {
  let client: ReturnType<typeof getAiClient>;
  try {
    client = getAiClient();
  } catch {
    return NextResponse.json({ category: null, konto: null, confidence: 0, reasoning: 'API key not configured' });
  }

  const body = await request.json();
  const { ocrText, vendor, gross, date, items, userRules } = body as {
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

  const systemPrompt = `You are a receipt classification assistant for German business expense tracking (SKR03).

Given a receipt's OCR text, vendor, and amount, classify it into:
1. **Category** — one of: ${CATEGORY_NAMES.join(', ')}
2. **Konto** — the SKR03 account number (mapped from category):
${CATEGORY_NAMES.map((c) => `   ${c} → ${CATEGORY_TO_KONTO[c]}`).join('\n')}
3. **Zuordnung** (assignment context) — one of: ${ZUORDNUNG_OPTIONS.join(', ')}

${userRules || ''}

Respond with ONLY a JSON object (no markdown, no explanation):
{ "category": "...", "konto": "...", "zuordnung": "...", "confidence": 0.0-1.0, "reasoning": "..." }`;

  const userContent = [
    vendor && `Vendor: ${vendor}`,
    gross && `Amount: €${gross}`,
    date && `Date: ${date}`,
    items?.length && `Items: ${items.join(', ')}`,
    `\nOCR Text (first 2000 chars):\n${ocrText.slice(0, 2000)}`,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const response = await client.chat.completions.create({
      model: getClassifyModel(),
      max_tokens: 256,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    });

    const text = response.choices[0]?.message?.content ?? '';
    // Strip markdown fences if the model wraps the JSON
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);

    return NextResponse.json({
      category: CATEGORY_NAMES.includes(parsed.category) ? parsed.category : null,
      konto: parsed.konto || (parsed.category ? CATEGORY_TO_KONTO[parsed.category] : null),
      zuordnung: ZUORDNUNG_OPTIONS.includes(parsed.zuordnung) ? parsed.zuordnung : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      reasoning: parsed.reasoning || '',
    });
  } catch (err) {
    console.error('[classify-single] Classification failed:', err);
    return NextResponse.json({ category: null, konto: null, confidence: 0, reasoning: 'Classification failed' });
  }
}
