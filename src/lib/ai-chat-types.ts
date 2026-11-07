export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: PendingToolCall[];
  appliedToolCalls?: AppliedToolCall[];
  timestamp: number;
}

export interface PendingToolCall {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  preview: string;
  /** 'failed': approved, but the change could not be saved (a statement the server refused). */
  status: 'pending' | 'approved' | 'rejected' | 'failed';
}

export interface AppliedToolCall {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string;
}

export interface ChatStreamEvent {
  type: 'text_delta' | 'tool_use' | 'done' | 'error';
  content?: string;
  toolCall?: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  };
  error?: string;
}
