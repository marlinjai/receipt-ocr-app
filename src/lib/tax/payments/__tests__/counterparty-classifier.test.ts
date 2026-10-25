import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ModelCounterparty } from '../classify';
import { askAnthropic, classifyWithAnthropic, serverCounterpartyClassifier } from '../counterparty-classifier';

/** Every name is invented; no test reaches a real model. */
const counterparty = (name: string, mayLookUp: boolean): ModelCounterparty => ({
  key: name.toLowerCase(),
  name,
  payments: 2,
  paidEuro: '40.00',
  receivedEuro: '0.00',
  texts: ['Abo'],
  privateAccount: false,
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
  it('a name that may be a person never goes out with web search: business names and the others are asked apart', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const business = counterparty('Werkzeug Abo Beispiel GmbH', true);
    const person = counterparty('Max Beispiel', false);
    const { client, create } = fakeClient(answer([business.key]), answer([person.key]));
    const verdicts = await classifyWithAnthropic(client, 'test-model', [person, business]);
    expect([...verdicts.keys()].sort()).toEqual([person.key, business.key].sort());
    const [withSearch, without] = create.mock.calls.map((call) => (call as unknown[])[0] as { tools?: unknown[]; messages: Array<{ content: string }>; system: string });
    expect(withSearch.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]);
    expect(withSearch.messages[0].content).toContain('Werkzeug Abo Beispiel GmbH');
    expect(withSearch.messages[0].content).not.toContain('Max Beispiel');
    expect(without.tools).toBeUndefined();
    expect(without.system).toMatch(/You have no web search/);
    expect(without.messages[0].content).toContain('Max Beispiel');
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
