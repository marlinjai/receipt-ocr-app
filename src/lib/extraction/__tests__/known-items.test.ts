import { describe, expect, it } from 'vitest';
import { KNOWN_ITEMS_LIMIT, itemKey, pickKnownItem, rankItems, vendorSearchWord } from '../known-items';
import { classificationPrompt, KNOWN_ITEMS_RULE } from '@/lib/receipt-classifier';

describe('pickKnownItem: an earlier wording of the same item is taken over as stored', () => {
  const known = ['PocketTube Abo', 'Kanal-Paket'];

  it('the same subscription in other words, case or punctuation takes the stored wording', () => {
    expect(pickKnownItem('PocketTube-Mitgliedschaft', known)).toBe('PocketTube Abo');
    expect(pickKnownItem('pockettube abonnement', known)).toBe('PocketTube Abo');
    expect(pickKnownItem('Kanal Paket', known)).toBe('Kanal-Paket');
  });

  it('something else stays as the model worded it, and nothing stays nothing', () => {
    expect(pickKnownItem('Speicher-Erweiterung', known)).toBe('Speicher-Erweiterung');
    expect(pickKnownItem('PocketTube Pro', known)).toBe('PocketTube Pro');
    expect(pickKnownItem(null, known)).toBeNull();
    expect(pickKnownItem('Abo', known)).toBe('Abo');
    expect(pickKnownItem('PocketTube Abo', [])).toBe('PocketTube Abo');
  });

  it('itemKey drops only the words that say "subscription"', () => {
    expect(itemKey('ChatGPT Plus Monatsabo')).toBe('chatgptplus');
    expect(itemKey('Creative Cloud Foto-Abo')).toBe('creativecloudfoto');
  });
});

describe('rankItems: the vendor\'s wordings, the most used first', () => {
  it('counts every spelling of the vendor, each wording once, ties in the order first seen', () => {
    const stored = [
      { vendor: 'Musterhost', item: 'Domainverlängerung' },
      { vendor: 'Musterhost LLC', item: 'Webhosting Basic' },
      { vendor: 'MUSTERHOST', item: 'Webhosting Basic' },
      { vendor: 'Musterhost', item: '  ' },
      { vendor: 'Musterhost', item: null },
      { vendor: 'Musterhosting Plus', item: 'Fremdes Paket' },
      { vendor: null, item: 'Ohne Händler' },
    ];
    expect(rankItems('Musterhost', stored)).toEqual(['Webhosting Basic', 'Domainverlängerung']);
  });

  it('no vendor, no wordings; never more than the limit', () => {
    expect(rankItems(null, [{ vendor: 'X', item: 'Y' }])).toEqual([]);
    const many = Array.from({ length: KNOWN_ITEMS_LIMIT + 5 }, (_, i) => ({ vendor: 'Viel', item: `Posten ${i}` }));
    expect(rankItems('Viel', many)).toHaveLength(KNOWN_ITEMS_LIMIT);
  });
});

describe('vendorSearchWord', () => {
  it('is the longest word without the legal form', () => {
    expect(vendorSearchWord('Example Video Tools Inc.')).toBe('Example');
    expect(vendorSearchWord('A2 Hosting LLC')).toBe('Hosting');
    expect(vendorSearchWord('Hetzner Online GmbH')).toBe('Hetzner');
  });

  it('is null where nothing is long enough', () => {
    expect(vendorSearchWord(null)).toBeNull();
    expect(vendorSearchWord('AB')).toBeNull();
    expect(vendorSearchWord('GmbH')).toBeNull();
  });
});

describe('the prompt names the rule only where there are earlier wordings', () => {
  const base = { vendor: null, gross: null, date: null, fullText: 'x', categoryNames: ['Sonstige Ausgaben'], categoryToKonto: { 'Sonstige Ausgaben': '4900' }, zuordnungOptions: [] };

  it('with and without known items', () => {
    expect(classificationPrompt({ ...base, knownItems: ['PocketTube Abo'] }, { webSearch: false })).toContain(KNOWN_ITEMS_RULE);
    expect(classificationPrompt({ ...base, knownItems: [] }, { webSearch: false })).not.toContain(KNOWN_ITEMS_RULE);
    expect(classificationPrompt(base, { webSearch: false })).not.toContain(KNOWN_ITEMS_RULE);
  });
});
