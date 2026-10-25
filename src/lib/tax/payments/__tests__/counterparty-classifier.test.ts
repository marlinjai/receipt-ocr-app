import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ModelCounterparty } from '../classify';
import { answerText, askAnthropic, classifyWithAnthropic, serverCounterpartyClassifier } from '../counterparty-classifier';

/** Every name is invented; no test reaches a real model. */
const counterparty = (name: string, mayLookUp: boolean): ModelCounterparty => ({
  key: name.toLowerCase(),
  name,
  payments: 2,
  paidEuro: '40.00',
  receivedEuro: '0.00',
  texts: ['Abo'],
  linkedReceipts: 'none',
  mayLookUp,
});

const answer = (keys: string[], stop = 'end_turn') => ({
  stop_reason: stop,
  usage: { input_tokens: 100, output_tokens: 50 },
  content: [{ type: 'text', text: JSON.stringify({ verdicts: keys.map((key) => ({ key, treatment: 'business', category: 'software_ai_hosting', confidence: 'certain', reason: 'Software' })) }) }],
});

/** A client whose `messages.create` returns the answers in order and records every request. */
function fakeClient(...responses: unknown[]) {
  const create = vi.fn(async () => responses.shift());
  return { client: { messages: { create } } as unknown as Pick<Anthropic, 'messages'>, create };
}

describe('asking the model', () => {
  it('web search is given only when every counterparty of the call may be looked up', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const business = counterparty('Werkzeug Abo Beispiel GmbH', true);
    const person = counterparty('Max Beispiel', false);
    const { client, create } = fakeClient(answer([business.key]), answer([person.key]), answer([business.key, person.key]));
    expect([...(await classifyWithAnthropic(client, 'test-model', [business])).keys()]).toEqual([business.key]);
    await classifyWithAnthropic(client, 'test-model', [person]);
    await classifyWithAnthropic(client, 'test-model', [business, person]);
    const requests = create.mock.calls.map((call) => (call as unknown[])[0] as { tools?: unknown[]; system: string });
    expect(requests[0].tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]);
    expect(requests[1].tools).toBeUndefined();
    expect(requests[1].system).toMatch(/You have no web search/);
    // A mixed group (the service never builds one) gets no search either.
    expect(requests[2].tools).toBeUndefined();
  });

  it('reads an answer split into several text blocks around the search results', () => {
    const json = JSON.stringify({ verdicts: [{ key: 'k', treatment: 'business', category: null, confidence: 'certain', reason: 'r' }] });
    const content = [
      { type: 'text', text: 'Ich suche.' },
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: {} },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [] },
      { type: 'text', text: json.slice(0, 20) },
      { type: 'text', text: json.slice(20) },
    ] as unknown as Anthropic.ContentBlock[];
    expect(answerText(content)).toBe(json);
  });

  it('a paused turn is resumed; one that never finishes, a refusal or a cut-off answer is an error, never an empty verdict', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const one = [counterparty('Werkzeug Abo Beispiel GmbH', true)];
    const paused = { stop_reason: 'pause_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: [] };
    const resumed = fakeClient(paused, answer([one[0].key]));
    expect(await askAnthropic(resumed.client, 'm', one)).toContain('verdicts');
    expect(resumed.create).toHaveBeenCalledTimes(2);
    await expect(askAnthropic(fakeClient(paused, paused, paused, paused).client, 'm', one)).rejects.toThrow(/did not finish/);
    await expect(askAnthropic(fakeClient({ ...paused, stop_reason: 'refusal' }).client, 'm', one)).rejects.toThrow(/declined/);
    await expect(askAnthropic(fakeClient({ ...paused, stop_reason: 'max_tokens' }).client, 'm', one)).rejects.toThrow(/cut off/);
  });

  it('without a key there is no classifier, and the server says so instead of guessing', () => {
    expect(serverCounterpartyClassifier({})).toBeNull();
    expect(serverCounterpartyClassifier({ OPENROUTER_API_KEY: 'test-key' })?.model).toBeTruthy();
    expect(serverCounterpartyClassifier({ ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_COUNTERPARTY_MODEL: 'some-model' })?.model).toBe('some-model');
  });
});
