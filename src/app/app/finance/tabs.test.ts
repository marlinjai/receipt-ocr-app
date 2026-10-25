import { describe, expect, it } from 'vitest';
import { GROUPS, addressOf, defaultTab, groupCount, groupOf, tabFromAddress, waitingCounts, type TabKey } from './tabs';
import type { StatementView } from '@/lib/tax/service';

const ALL_TABS = GROUPS.flatMap((g) => g.tabs.map((t) => t.key));

describe('the groups of the Finanzen page', () => {
  it('are four, in the decided order, and every tab sits in exactly one of them', () => {
    expect(GROUPS.map((g) => g.label)).toEqual(['Erledigen', 'Auswerten', 'Steuer', 'Einstellungen']);
    expect(new Set(ALL_TABS).size).toBe(ALL_TABS.length);
    expect(GROUPS.find((g) => g.key === 'todo')!.tabs.map((t) => t.key)).toEqual(['open', 'questions']);
    expect(GROUPS.find((g) => g.key === 'review')!.tabs.map((t) => t.key)).toEqual(['statement', 'revenue', 'payments', 'assets']);
    expect(GROUPS.find((g) => g.key === 'taxes')!.tabs.map((t) => t.key)).toEqual(['vat', 'tax']);
    expect(GROUPS.find((g) => g.key === 'settings')!.tabs.map((t) => t.key)).toEqual(['accounts', 'vendors', 'names']);
  });

  it('no two tabs carry the same label or address, and no address is also a group address', () => {
    const labels = GROUPS.flatMap((g) => g.tabs.map((t) => t.label));
    const addresses = GROUPS.flatMap((g) => [g.address, ...g.tabs.map((t) => t.address)]);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(addresses).size).toBe(addresses.length);
  });
});

describe('tabFromAddress', () => {
  it('resume: every tab is found again from its own address', () => {
    for (const tab of ALL_TABS) expect(tabFromAddress(addressOf(tab))).toBe(tab);
  });

  it('a group address opens the group on its first tab', () => {
    expect(tabFromAddress('erledigen')).toBe('open');
    expect(tabFromAddress('auswerten')).toBe('statement');
    expect(tabFromAddress('steuer')).toBe('vat');
    expect(tabFromAddress('einstellungen')).toBe('accounts');
  });

  it('the old value "zahlungen" still works and opens the payment questions under Erledigen', () => {
    expect(tabFromAddress('zahlungen')).toBe('questions');
    expect(groupOf(tabFromAddress('zahlungen')!).label).toBe('Erledigen');
  });

  it('re-entry: the return from the bank opens the accounts under Einstellungen, whatever reiter says', () => {
    expect(tabFromAddress('zahlungen', true)).toBe('accounts');
    expect(tabFromAddress(undefined, true)).toBe('accounts');
    expect(tabFromAddress('euer', true)).toBe('accounts');
    expect(groupOf('accounts').label).toBe('Einstellungen');
  });

  it('takes the value however it is written, and names no tab for anything else', () => {
    expect(tabFromAddress(' Konten ')).toBe('accounts');
    expect(tabFromAddress('ZAHLUNGEN')).toBe('questions');
    for (const value of [undefined, null, '', 'jahreswechsel', 'payments', 'open', 'konten2']) expect(tabFromAddress(value)).toBeUndefined();
  });
});

function counts(over: { queue?: number; overdue?: number; open?: number; unclassified?: number; assetChecks?: number }) {
  const view = {
    assets: [{ checks: [] }, ...Array.from({ length: over.assetChecks ?? 0 }, () => ({ checks: [{ kind: 'x' }] }))],
    revenue: { overdue: Array.from({ length: over.overdue ?? 0 }, () => ({})) },
    payments: { open: Array.from({ length: over.open ?? 0 }, () => ({})), unclassified: Array.from({ length: over.unclassified ?? 0 }, () => ({})) },
  } as unknown as StatementView;
  return waitingCounts(view, over.queue ?? 0);
}

describe('counts and the first tab', () => {
  it('forward: the count of Erledigen is everything that waits, and only Erledigen carries one', () => {
    const c = counts({ queue: 3, overdue: 1, open: 2, unclassified: 4 });
    expect(c).toEqual({ open: 4, questions: 6 });
    const byGroup = Object.fromEntries(GROUPS.map((g) => [g.key, groupCount(g, c)]));
    expect(byGroup).toEqual({ todo: 10, review: undefined, taxes: undefined, settings: undefined });
  });

  it('assets with an open check count on Anlagen and so on Auswerten; without any, Auswerten carries no count', () => {
    const c = counts({ queue: 1, assetChecks: 2 });
    expect(c).toEqual({ open: 1, questions: 0, assets: 2 });
    expect(groupCount(GROUPS.find((g) => g.key === 'review')!, c)).toBe(2);
    expect(groupCount(GROUPS.find((g) => g.key === 'review')!, counts({ queue: 1 }))).toBeUndefined();
  });

  it('opens on the first work that waits, else on the statement', () => {
    const cases: Array<[Parameters<typeof counts>[0], TabKey]> = [
      [{ queue: 1 }, 'open'],
      [{ overdue: 1, open: 5 }, 'open'],
      [{ open: 1 }, 'questions'],
      [{ unclassified: 1 }, 'questions'],
      [{}, 'statement'],
      [{ assetChecks: 3 }, 'statement'],
    ];
    for (const [input, tab] of cases) expect(defaultTab(counts(input))).toBe(tab);
  });
});
