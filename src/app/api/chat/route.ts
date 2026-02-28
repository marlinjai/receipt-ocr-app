import { NextRequest } from 'next/server';
import { getAiClient, getChatModel } from '@/lib/ai-client';
import { TABLE_TOOLS } from '@/lib/ai-chat-tools';
import { CATEGORY_TO_KONTO, ZUORDNUNG_OPTIONS } from '@/lib/receipts-table';
import type OpenAI from 'openai';

const CATEGORY_NAMES = Object.keys(CATEGORY_TO_KONTO);

function buildSystemPrompt(tableContext: {
  columns: Array<{ name: string; type: string }>;
  rowCount: number;
  selectOptions: Record<string, Array<{ id: string; name: string }>>;
  userRules?: string;
}): string {
  const columnList = tableContext.columns
    .map((c) => `  - ${c.name} (${c.type})`)
    .join('\n');

  const selectInfo = Object.entries(tableContext.selectOptions)
    .map(([col, opts]) => `  ${col}: ${opts.map((o) => o.name).join(', ')}`)
    .join('\n');

  return `You are an AI assistant for managing receipt/expense data in a table. The user can ask you to read, classify, update, or delete receipt data.

## Table Schema
${columnList}

Total rows: ${tableContext.rowCount}

## Select Column Options
${selectInfo}

## SKR03 Category → Konto Mapping
${CATEGORY_NAMES.map((c) => `  ${c} → ${CATEGORY_TO_KONTO[c]}`).join('\n')}

## Zuordnung (Assignment Context)
Options: ${ZUORDNUNG_OPTIONS.join(', ')}
- Universität = university-related expenses
- Geschäftlich = business expenses
- Privat = personal expenses

${tableContext.userRules || ''}

## Instructions
- Use tools to read and modify data. Always read data first before making changes.
- For select columns (Category, Status, Zuordnung), use the **option name** (e.g. "Bewirtung"), not the option ID.
- When classifying receipts, examine the OCR Text and Vendor columns to determine Category, Konto, and Zuordnung.
- When updating Konto, use the SKR03 mapping above based on the Category.
- Explain what you plan to do before calling update/delete tools.
- Be concise in your responses. Use German column names when referencing them.
- If the user asks you to classify receipts, read the rows first, then use update_cells or bulk_update to set Category, Konto, and optionally Zuordnung.`;
}

export async function POST(request: NextRequest) {
  let client: ReturnType<typeof getAiClient>;
  try {
    client = getAiClient();
  } catch {
    return new Response(
      JSON.stringify({ error: 'OPENROUTER_API_KEY not configured' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const body = await request.json();
  const { messages, tableContext } = body as {
    messages: Array<{ role: string; content: unknown }>;
    tableContext: {
      columns: Array<{ name: string; type: string }>;
      rowCount: number;
      selectOptions: Record<string, Array<{ id: string; name: string }>>;
      userRules?: string;
    };
  };

  const systemPrompt = buildSystemPrompt(tableContext);
  const model = getChatModel();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(event: { type: string; [key: string]: unknown }) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }

      try {
        const apiMessages: OpenAI.ChatCompletionMessageParam[] = [
          { role: 'system', content: systemPrompt },
          ...(messages as OpenAI.ChatCompletionMessageParam[]),
        ];

        const response = await client.chat.completions.create({
          model,
          max_tokens: 4096,
          tools: TABLE_TOOLS,
          messages: apiMessages,
          stream: true,
        });

        // Track tool calls being streamed (OpenAI streams them incrementally)
        const pendingToolCalls = new Map<
          number,
          { id: string; name: string; arguments: string }
        >();

        for await (const chunk of response) {
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          // Text content
          if (delta.content) {
            send({ type: 'text_delta', content: delta.content });
          }

          // Tool calls (streamed incrementally by index)
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!pendingToolCalls.has(idx)) {
                pendingToolCalls.set(idx, {
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  arguments: '',
                });
              }
              const pending = pendingToolCalls.get(idx)!;
              if (tc.id) pending.id = tc.id;
              if (tc.function?.name) pending.name = tc.function.name;
              if (tc.function?.arguments) pending.arguments += tc.function.arguments;
            }
          }

          // Check if this chunk signals the end
          const finishReason = chunk.choices[0]?.finish_reason;
          if (finishReason === 'tool_calls' || finishReason === 'stop') {
            // Emit all collected tool calls
            for (const [, tc] of pendingToolCalls) {
              let input: Record<string, unknown> = {};
              try {
                input = tc.arguments ? JSON.parse(tc.arguments) : {};
              } catch {
                // If JSON parsing fails, send empty input
              }
              send({
                type: 'tool_use',
                toolCall: { id: tc.id, name: tc.name, input },
              });
            }
            send({ type: 'done' });
          }
        }
      } catch (err) {
        send({
          type: 'error',
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
