import { describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { ModelCounterparty } from '../classify';
import { classifyWithAnthropic } from '../counterparty-classifier';

/**
 * The counterparty classifier through the real `@anthropic-ai/sdk` client,
 * with only `fetch` faked: the request the SDK puts on the wire (endpoint,
 * key header, body with the web search tool and `output_config`), its parsing
 * of the Messages API answer, and the resume of a paused server-tool turn.
 * The other tests use a fake client and would not notice an SDK upgrade that
 * changed any of this. Every name is invented; nothing reaches a real model.
 */

const business: ModelCounterparty = {
  key: 'werkzeug abo beispiel gmbh',
  name: 'Werkzeug Abo Beispiel GmbH',
  payments: 2,
  paidEuro: '40.00',
  receivedEuro: '0.00',
  invoices: 'none',
  filedReturns: 'none',
  texts: ['Abo'],
  linkedReceipts: 'none',
  mayLookUp: true,
  personSays: null,
};

function apiMessage(stopReason: string, content: unknown[]) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
    content,
  };
}

const verdicts = JSON.stringify({ verdicts: [{ key: business.key, treatment: 'business', category: 'software_ai_hosting', confidence: 'certain', reason: 'Software' }] });

describe('classifyWithAnthropic (real Anthropic SDK client)', () => {
  it('sends the Messages API request, resumes a paused turn and reads the verdict', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.anthropic.test/v1/messages');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('test-key-not-a-secret');
      bodies.push(JSON.parse(String(init?.body)));
      const message =
        bodies.length === 1
          ? apiMessage('pause_turn', [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'Werkzeug Abo' } }])
          : apiMessage('end_turn', [{ type: 'text', text: verdicts, citations: null }]);
      return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
    });
    const client = new Anthropic({ apiKey: 'test-key-not-a-secret', baseURL: 'https://api.anthropic.test', maxRetries: 0, fetch: fetchMock as unknown as typeof fetch });

    const result = await classifyWithAnthropic(client, 'test-model', [business]);

    expect(result.get(business.key)).toMatchObject({ treatment: 'business', category: 'software_ai_hosting' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toMatchObject({
      model: 'test-model',
      max_tokens: 16000,
      output_config: { effort: 'low' },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
    });
    // The paused content goes back as the assistant turn, so the server can resume it.
    const resumed = bodies[1].messages as Array<{ role: string; content: unknown }>;
    expect(resumed.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(resumed[1].content).toEqual([{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'Werkzeug Abo' } }]);
  });

  it('surfaces an API error instead of an empty verdict', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const client = new Anthropic({ apiKey: 'test-key-not-a-secret', baseURL: 'https://api.anthropic.test', maxRetries: 0, fetch: fetchMock as unknown as typeof fetch });

    await expect(classifyWithAnthropic(client, 'test-model', [business])).rejects.toBeInstanceOf(Anthropic.AuthenticationError);
  });
});
