'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { Column, Row, CellValue } from '@marlinjai/data-table-core';
import type { ChatMessage, PendingToolCall, AppliedToolCall, ChatStreamEvent } from '@/lib/ai-chat-types';
import { isReadOnlyTool } from '@/lib/ai-chat-tools';
import { getRules, rulesToPromptText } from '@/lib/classification-rules';

interface SelectOption {
  id: string;
  columnId: string;
  name: string;
  color?: string;
}

interface AiChatSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  rows: Row[];
  columns: Column[];
  selectOptions: Map<string, SelectOption[]>;
  onCellChange: (rowId: string, columnId: string, value: CellValue) => void;
  onAddRow: (cells?: Record<string, CellValue>) => Promise<void>;
  onDeleteRow: (rowId: string) => void;
  onCreateSelectOption: (params: {
    columnId: string;
    name: string;
    color?: string;
  }) => Promise<SelectOption>;
  tableId: string;
}

// ── Tool Execution ────────────────────────────────────────────────────

function executeReadOnlyTool(
  toolName: string,
  input: Record<string, unknown>,
  rows: Row[],
  columns: Column[],
  selectOptions: Map<string, SelectOption[]>,
): string {
  switch (toolName) {
    case 'get_columns': {
      const cols = columns.map((c) => ({ name: c.name, type: c.type, id: c.id }));
      return JSON.stringify(cols, null, 2);
    }
    case 'get_select_options': {
      const colName = input.columnName as string;
      const col = columns.find((c) => c.name === colName);
      if (!col) return JSON.stringify({ error: `Column "${colName}" not found` });
      const opts = selectOptions.get(col.id) ?? [];
      return JSON.stringify(opts.map((o) => ({ id: o.id, name: o.name })));
    }
    case 'get_rows': {
      const limit = (input.limit as number) || 50;
      const filter = input.filter as Record<string, string> | undefined;

      let filtered = rows;
      if (filter) {
        filtered = rows.filter((row) => {
          return Object.entries(filter).every(([colName, matchValue]) => {
            const col = columns.find((c) => c.name === colName);
            if (!col) return false;
            const cellVal = row.cells[col.id];
            if (cellVal == null) return false;

            // For select columns, resolve option ID to name
            if (col.type === 'select' || col.type === 'multi_select') {
              const opts = selectOptions.get(col.id) ?? [];
              const opt = opts.find((o) => o.id === String(cellVal));
              const optName = opt?.name ?? String(cellVal);
              return optName.toLowerCase().includes(matchValue.toLowerCase());
            }

            return String(cellVal).toLowerCase().includes(matchValue.toLowerCase());
          });
        });
      }

      const result = filtered.slice(0, limit).map((row) => {
        const cells: Record<string, unknown> = {};
        for (const col of columns) {
          const raw = row.cells[col.id];
          // Resolve select option IDs to names for readability
          if ((col.type === 'select' || col.type === 'multi_select') && raw) {
            const opts = selectOptions.get(col.id) ?? [];
            const opt = opts.find((o) => o.id === String(raw));
            cells[col.name] = opt?.name ?? raw;
          } else {
            cells[col.name] = raw ?? null;
          }
        }
        return { rowId: row.id, ...cells };
      });

      return JSON.stringify(result, null, 2);
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

function generatePreview(
  toolName: string,
  input: Record<string, unknown>,
  rows: Row[],
  columns: Column[],
  selectOptions: Map<string, SelectOption[]>,
): string {
  const getRowName = (rowId: string) => {
    const row = rows.find((r) => r.id === rowId);
    if (!row) return rowId;
    const primaryCol = columns.find((c) => c.isPrimary);
    if (!primaryCol) return rowId;
    return String(row.cells[primaryCol.id] ?? rowId);
  };

  switch (toolName) {
    case 'update_cells': {
      const rowId = input.rowId as string;
      const updates = input.updates as Record<string, unknown>;
      const name = getRowName(rowId);
      const changes = Object.entries(updates)
        .map(([col, val]) => `${col}: "${val}"`)
        .join(', ');
      return `Update "${name}": ${changes}`;
    }
    case 'bulk_update': {
      const rowIds = input.rowIds as string[];
      const updates = input.updates as Record<string, unknown>;
      const changes = Object.entries(updates)
        .map(([col, val]) => `${col} → "${val}"`)
        .join(', ');
      return `Update ${rowIds.length} rows: ${changes}`;
    }
    case 'create_row': {
      const cells = input.cells as Record<string, unknown>;
      const fields = Object.entries(cells)
        .map(([k, v]) => `${k}: "${v}"`)
        .join(', ');
      return `Create new row: ${fields}`;
    }
    case 'delete_rows': {
      const rowIds = input.rowIds as string[];
      const names = rowIds.map(getRowName);
      return `Delete ${rowIds.length} row(s): ${names.join(', ')}`;
    }
    default:
      return `Execute ${toolName}`;
  }
}

// ── Resolve select option name → ID ──────────────────────────────────

function resolveSelectValue(
  colName: string,
  value: unknown,
  columns: Column[],
  selectOptions: Map<string, SelectOption[]>,
): CellValue {
  const col = columns.find((c) => c.name === colName);
  if (!col) return value as CellValue;

  if (col.type === 'select' || col.type === 'multi_select') {
    const opts = selectOptions.get(col.id) ?? [];
    const match = opts.find(
      (o) => o.name.toLowerCase() === String(value).toLowerCase(),
    );
    return match ? match.id : (value as CellValue);
  }

  return value as CellValue;
}

// ── Component ─────────────────────────────────────────────────────────

export default function AiChatSidebar({
  isOpen,
  onClose,
  rows,
  columns,
  selectOptions,
  onCellChange,
  onAddRow,
  onDeleteRow,
  tableId,
}: AiChatSidebarProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when sidebar opens
  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  const buildTableContext = useCallback(() => {
    const selectOptsRecord: Record<string, Array<{ id: string; name: string }>> = {};
    for (const col of columns) {
      if (col.type === 'select' || col.type === 'multi_select') {
        const opts = selectOptions.get(col.id) ?? [];
        selectOptsRecord[col.name] = opts.map((o) => ({ id: o.id, name: o.name }));
      }
    }

    const rules = getRules();
    return {
      columns: columns.map((c) => ({ name: c.name, type: c.type })),
      rowCount: rows.length,
      selectOptions: selectOptsRecord,
      userRules: rulesToPromptText(rules),
    };
  }, [columns, rows.length, selectOptions]);

  // Execute approved tool calls
  const executeToolCall = useCallback(
    async (toolCall: PendingToolCall) => {
      const { toolName, input: toolInput } = toolCall;

      switch (toolName) {
        case 'update_cells': {
          const rowId = toolInput.rowId as string;
          const updates = toolInput.updates as Record<string, unknown>;
          for (const [colName, value] of Object.entries(updates)) {
            const col = columns.find((c) => c.name === colName);
            if (col) {
              const resolved = resolveSelectValue(colName, value, columns, selectOptions);
              onCellChange(rowId, col.id, resolved);
            }
          }
          break;
        }
        case 'bulk_update': {
          const rowIds = toolInput.rowIds as string[];
          const updates = toolInput.updates as Record<string, unknown>;
          for (const rowId of rowIds) {
            for (const [colName, value] of Object.entries(updates)) {
              const col = columns.find((c) => c.name === colName);
              if (col) {
                const resolved = resolveSelectValue(colName, value, columns, selectOptions);
                onCellChange(rowId, col.id, resolved);
              }
            }
          }
          break;
        }
        case 'create_row': {
          const cells = toolInput.cells as Record<string, unknown>;
          const resolvedCells: Record<string, CellValue> = {};
          for (const [colName, value] of Object.entries(cells)) {
            const col = columns.find((c) => c.name === colName);
            if (col) {
              resolvedCells[col.id] = resolveSelectValue(colName, value, columns, selectOptions);
            }
          }
          await onAddRow(resolvedCells);
          break;
        }
        case 'delete_rows': {
          const rowIds = toolInput.rowIds as string[];
          for (const rowId of rowIds) {
            onDeleteRow(rowId);
          }
          break;
        }
      }
    },
    [columns, selectOptions, onCellChange, onAddRow, onDeleteRow],
  );

  const handleApprove = useCallback(
    (messageId: string, toolCallId: string) => {
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== messageId) return msg;
          const tc = msg.toolCalls?.find((t) => t.id === toolCallId);
          if (tc) {
            tc.status = 'approved';
            executeToolCall(tc);
          }
          return { ...msg };
        }),
      );
    },
    [executeToolCall],
  );

  const handleReject = useCallback((messageId: string, toolCallId: string) => {
    setMessages((prev) =>
      prev.map((msg) => {
        if (msg.id !== messageId) return msg;
        const tc = msg.toolCalls?.find((t) => t.id === toolCallId);
        if (tc) tc.status = 'rejected';
        return { ...msg };
      }),
    );
  }, []);

  const handleApproveAll = useCallback(
    (messageId: string) => {
      setMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== messageId) return msg;
          const pending = msg.toolCalls?.filter((t) => t.status === 'pending') ?? [];
          for (const tc of pending) {
            tc.status = 'approved';
            executeToolCall(tc);
          }
          return { ...msg };
        }),
      );
    },
    [executeToolCall],
  );

  // ── Send Message ────────────────────────────────────────────────────

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    setInput('');
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setIsStreaming(true);

    const assistantMsgId = crypto.randomUUID();
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      toolCalls: [],
      appliedToolCalls: [],
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, assistantMsg]);

    // Build conversation history for API (OpenAI / OpenRouter format)
    const apiMessages: Array<{ role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string }> = [];
    for (const msg of updatedMessages) {
      if (msg.role === 'user') {
        apiMessages.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        // Assistant message with optional tool_calls
        const assistantEntry: { role: string; content: string | null; tool_calls?: unknown[] } = {
          role: 'assistant',
          content: msg.content || null,
        };
        if (msg.appliedToolCalls && msg.appliedToolCalls.length > 0) {
          assistantEntry.tool_calls = msg.appliedToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.toolName,
              arguments: JSON.stringify(tc.input),
            },
          }));
        }
        apiMessages.push(assistantEntry);

        // Tool result messages (role: 'tool')
        if (msg.appliedToolCalls) {
          for (const tc of msg.appliedToolCalls) {
            apiMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: tc.result,
            });
          }
        }
      }
    }

    const abortController = new AbortController();
    abortRef.current = abortController;

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          tableContext: buildTableContext(),
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const err = await response.text();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, content: `Error: ${err}` } : m,
          ),
        );
        setIsStreaming(false);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        setIsStreaming(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      const collectedToolCalls: PendingToolCall[] = [];
      const appliedToolCalls: AppliedToolCall[] = [];
      let contentSoFar = '';
      let continueConversation = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          let event: ChatStreamEvent;
          try {
            event = JSON.parse(jsonStr);
          } catch {
            continue;
          }

          switch (event.type) {
            case 'text_delta': {
              contentSoFar += event.content ?? '';
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId ? { ...m, content: contentSoFar } : m,
                ),
              );
              break;
            }
            case 'tool_use': {
              const tc = event.toolCall!;

              if (isReadOnlyTool(tc.name)) {
                // Execute immediately and collect for multi-turn
                const result = executeReadOnlyTool(
                  tc.name,
                  tc.input,
                  rows,
                  columns,
                  selectOptions,
                );
                appliedToolCalls.push({
                  id: tc.id,
                  toolName: tc.name,
                  input: tc.input,
                  result,
                });
                continueConversation = true;
              } else {
                // Write tool — show preview
                const preview = generatePreview(
                  tc.name,
                  tc.input,
                  rows,
                  columns,
                  selectOptions,
                );
                collectedToolCalls.push({
                  id: tc.id,
                  toolName: tc.name,
                  input: tc.input,
                  preview,
                  status: 'pending',
                });
              }
              break;
            }
            case 'error': {
              contentSoFar += `\n\nError: ${event.error}`;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId ? { ...m, content: contentSoFar } : m,
                ),
              );
              break;
            }
          }
        }
      }

      // Update the assistant message with tool calls
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                content: contentSoFar,
                toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
                appliedToolCalls: appliedToolCalls.length > 0 ? appliedToolCalls : undefined,
              }
            : m,
        ),
      );

      // If we executed read-only tools, continue the conversation
      if (continueConversation && appliedToolCalls.length > 0) {
        setIsStreaming(false);
        // Build follow-up messages including tool results (OpenAI format)
        const followUpMessages = [
          ...apiMessages,
        ];

        // Add assistant message with tool_calls
        followUpMessages.push({
          role: 'assistant',
          content: contentSoFar || null,
          tool_calls: appliedToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.toolName,
              arguments: JSON.stringify(tc.input),
            },
          })),
        });

        // Add tool result messages (role: 'tool')
        for (const tc of appliedToolCalls) {
          followUpMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: tc.result,
          });
        }

        // Make another API call
        setIsStreaming(true);
        const followUpId = crypto.randomUUID();
        const followUpMsg: ChatMessage = {
          id: followUpId,
          role: 'assistant',
          content: '',
          toolCalls: [],
          appliedToolCalls: [],
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, followUpMsg]);

        try {
          const followUpRes = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: followUpMessages,
              tableContext: buildTableContext(),
            }),
            signal: abortController.signal,
          });

          if (followUpRes.ok && followUpRes.body) {
            const followReader = followUpRes.body.getReader();
            let followBuffer = '';
            let followContent = '';
            const followToolCalls: PendingToolCall[] = [];

            while (true) {
              const { done: fDone, value: fValue } = await followReader.read();
              if (fDone) break;

              followBuffer += decoder.decode(fValue, { stream: true });
              const fLines = followBuffer.split('\n');
              followBuffer = fLines.pop() ?? '';

              for (const fLine of fLines) {
                if (!fLine.startsWith('data: ')) continue;
                const fJson = fLine.slice(6).trim();
                if (!fJson) continue;

                let fEvent: ChatStreamEvent;
                try {
                  fEvent = JSON.parse(fJson);
                } catch {
                  continue;
                }

                switch (fEvent.type) {
                  case 'text_delta': {
                    followContent += fEvent.content ?? '';
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === followUpId ? { ...m, content: followContent } : m,
                      ),
                    );
                    break;
                  }
                  case 'tool_use': {
                    const ftc = fEvent.toolCall!;
                    if (!isReadOnlyTool(ftc.name)) {
                      const preview = generatePreview(
                        ftc.name,
                        ftc.input,
                        rows,
                        columns,
                        selectOptions,
                      );
                      followToolCalls.push({
                        id: ftc.id,
                        toolName: ftc.name,
                        input: ftc.input,
                        preview,
                        status: 'pending',
                      });
                    }
                    break;
                  }
                }
              }
            }

            setMessages((prev) =>
              prev.map((m) =>
                m.id === followUpId
                  ? {
                      ...m,
                      content: followContent,
                      toolCalls: followToolCalls.length > 0 ? followToolCalls : undefined,
                    }
                  : m,
              ),
            );
          }
        } catch (err) {
          if ((err as Error).name !== 'AbortError') {
            console.error('[AiChat] Follow-up error:', err);
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, content: `Error: ${(err as Error).message}` }
              : m,
          ),
        );
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
    }
  }, [input, isStreaming, messages, rows, columns, selectOptions, buildTableContext]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    },
    [sendMessage],
  );

  const clearChat = useCallback(() => {
    setMessages([]);
    setInput('');
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsStreaming(false);
  }, []);

  if (!isOpen) return null;

  return (
    <div
      className="fixed top-0 right-0 h-screen flex flex-col"
      style={{
        width: '420px',
        zIndex: 50,
        background: 'rgba(10, 10, 15, 0.95)',
        borderLeft: '1px solid var(--border)',
        backdropFilter: 'blur(24px)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div className="flex items-center gap-2">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3l1.5 3.7 3.8.5-2.8 2.6.7 3.9L12 12l-3.2 1.7.7-3.9-2.8-2.6 3.8-.5z" />
            <path d="M12 3v0M18.4 5.6v0M21 12v0M18.4 18.4v0M12 21v0M5.6 18.4v0M3 12v0M5.6 5.6v0" />
          </svg>
          <span className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
            AI Assistant
          </span>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              onClick={clearChat}
              className="p-1.5 rounded-md text-xs transition-colors"
              style={{ color: 'var(--muted)' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--foreground)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}
              title="Clear chat"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 4 14 4" />
                <path d="M5.5 4V2.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V4" />
                <path d="M3.5 4l.7 9.1a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9L12.5 4" />
              </svg>
            </button>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-md transition-colors"
            style={{ color: 'var(--muted)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--foreground)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-center pt-12">
            <div className="mb-3">
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--muted)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mx-auto opacity-50"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              Ask me to classify receipts, update data, or query your table.
            </p>
            <div className="mt-4 space-y-1.5">
              {[
                'Classify all unclassified receipts',
                'Show all receipts from this month',
                'Set all Mensa receipts to Universität',
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => {
                    setInput(suggestion);
                    setTimeout(() => inputRef.current?.focus(), 0);
                  }}
                  className="block w-full text-left text-xs px-3 py-2 rounded-md transition-colors"
                  style={{
                    color: 'var(--accent)',
                    background: 'var(--accent-muted)',
                    border: '1px solid transparent',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'rgba(226, 163, 72, 0.3)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'transparent';
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id}>
            {msg.role === 'user' ? (
              <div className="flex justify-end">
                <div
                  className="max-w-[85%] px-3 py-2 rounded-lg text-sm"
                  style={{
                    background: 'var(--accent-muted)',
                    color: 'var(--foreground)',
                    border: '1px solid rgba(226, 163, 72, 0.2)',
                  }}
                >
                  {msg.content}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {msg.content && (
                  <div
                    className="max-w-[90%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap"
                    style={{
                      background: 'var(--surface)',
                      color: 'var(--foreground)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {msg.content}
                  </div>
                )}

                {/* Applied (read-only) tool calls — collapsible */}
                {msg.appliedToolCalls?.map((tc) => (
                  <details
                    key={tc.id}
                    className="rounded-md text-xs overflow-hidden"
                    style={{
                      background: 'rgba(59, 130, 246, 0.08)',
                      border: '1px solid rgba(59, 130, 246, 0.2)',
                    }}
                  >
                    <summary
                      className="px-3 py-1.5 cursor-pointer select-none"
                      style={{ color: '#60a5fa' }}
                    >
                      {tc.toolName}({Object.keys(tc.input).length > 0 ? '...' : ''})
                    </summary>
                    <div
                      className="px-3 py-2 font-mono text-xs overflow-x-auto max-h-40 overflow-y-auto"
                      style={{ color: 'var(--muted)', borderTop: '1px solid rgba(59, 130, 246, 0.15)' }}
                    >
                      <pre>{tc.result.slice(0, 2000)}</pre>
                    </div>
                  </details>
                ))}

                {/* Pending (write) tool calls — preview cards */}
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <div className="space-y-2">
                    {msg.toolCalls.map((tc) => (
                      <div
                        key={tc.id}
                        className="rounded-lg text-sm overflow-hidden"
                        style={{
                          background:
                            tc.status === 'approved'
                              ? 'rgba(16, 185, 129, 0.08)'
                              : tc.status === 'rejected'
                                ? 'rgba(239, 68, 68, 0.08)'
                                : tc.toolName === 'delete_rows'
                                  ? 'rgba(239, 68, 68, 0.08)'
                                  : 'rgba(226, 163, 72, 0.08)',
                          border: `1px solid ${
                            tc.status === 'approved'
                              ? 'rgba(16, 185, 129, 0.3)'
                              : tc.status === 'rejected'
                                ? 'rgba(239, 68, 68, 0.3)'
                                : tc.toolName === 'delete_rows'
                                  ? 'rgba(239, 68, 68, 0.3)'
                                  : 'rgba(226, 163, 72, 0.3)'
                          }`,
                        }}
                      >
                        <div className="px-3 py-2">
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className="text-xs font-medium px-1.5 py-0.5 rounded"
                              style={{
                                background:
                                  tc.toolName === 'delete_rows'
                                    ? 'rgba(239, 68, 68, 0.15)'
                                    : 'rgba(226, 163, 72, 0.15)',
                                color:
                                  tc.toolName === 'delete_rows'
                                    ? '#f87171'
                                    : 'var(--accent)',
                              }}
                            >
                              {tc.toolName}
                            </span>
                            {tc.status !== 'pending' && (
                              <span
                                className="text-xs"
                                style={{
                                  color:
                                    tc.status === 'approved'
                                      ? '#10b981'
                                      : '#ef4444',
                                }}
                              >
                                {tc.status === 'approved' ? 'Applied' : 'Rejected'}
                              </span>
                            )}
                          </div>
                          <p className="text-xs" style={{ color: 'var(--foreground)' }}>
                            {tc.preview}
                          </p>
                        </div>

                        {tc.status === 'pending' && (
                          <div
                            className="flex gap-2 px-3 py-2"
                            style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
                          >
                            <button
                              onClick={() => handleApprove(msg.id, tc.id)}
                              className="px-3 py-1 text-xs font-medium rounded-md transition-colors"
                              style={{
                                background: 'rgba(16, 185, 129, 0.15)',
                                color: '#10b981',
                                border: '1px solid rgba(16, 185, 129, 0.3)',
                              }}
                            >
                              Apply
                            </button>
                            <button
                              onClick={() => handleReject(msg.id, tc.id)}
                              className="px-3 py-1 text-xs font-medium rounded-md transition-colors"
                              style={{
                                background: 'rgba(239, 68, 68, 0.1)',
                                color: '#f87171',
                                border: '1px solid rgba(239, 68, 68, 0.2)',
                              }}
                            >
                              Reject
                            </button>
                          </div>
                        )}
                      </div>
                    ))}

                    {/* Approve All button when multiple pending */}
                    {msg.toolCalls.filter((t) => t.status === 'pending').length > 1 && (
                      <button
                        onClick={() => handleApproveAll(msg.id)}
                        className="w-full px-3 py-2 text-xs font-medium rounded-lg transition-colors"
                        style={{
                          background: 'rgba(16, 185, 129, 0.12)',
                          color: '#10b981',
                          border: '1px solid rgba(16, 185, 129, 0.25)',
                        }}
                      >
                        Apply All ({msg.toolCalls.filter((t) => t.status === 'pending').length} changes)
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {isStreaming && (
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--accent)', animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--accent)', animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--accent)', animationDelay: '300ms' }} />
            </div>
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              Thinking...
            </span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3" style={{ borderTop: '1px solid var(--border)' }}>
        <div
          className="flex items-end gap-2 rounded-lg px-3 py-2"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your receipts..."
            rows={1}
            className="flex-1 bg-transparent text-sm resize-none outline-none"
            style={{
              color: 'var(--foreground)',
              maxHeight: '120px',
            }}
            onInput={(e) => {
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = Math.min(el.scrollHeight, 120) + 'px';
            }}
            disabled={isStreaming}
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || isStreaming}
            className="p-1.5 rounded-md transition-colors shrink-0"
            style={{
              color: input.trim() && !isStreaming ? 'var(--accent)' : 'var(--muted)',
              opacity: input.trim() && !isStreaming ? 1 : 0.5,
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <p className="text-center text-xs mt-2" style={{ color: 'var(--muted)', opacity: 0.6 }}>
          AI can read and modify your receipt data
        </p>
      </div>
    </div>
  );
}
