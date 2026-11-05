import { describe, expect, it } from 'vitest';
import { KNOWN_ITEMS_LIMIT, itemKey, pickKnownItem, rankItems, vendorSearchWord, vendorSpelling } from '../known-items';
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

  it('itemKey drops only the words that say "subscription" and the small joining words', () => {
    expect(itemKey('ChatGPT Plus Monatsabo')).toBe('chatgptplus');
    expect(itemKey('Creative Cloud Foto-Abo')).toBe('creativecloudfoto');
    expect(itemKey('iCloud+ mit 2 TB')).toBe('icloud2tb');
    expect(itemKey('Microsoft 365 for Business')).toBe('microsoft365business');
  });

  it('the spellings of one iCloud plan come to the stored one; another plan stays', () => {
    const icloud = ['iCloud+ 2 TB'];
    expect(pickKnownItem('iCloud+ mit 2 TB', icloud)).toBe('iCloud+ 2 TB');
    expect(pickKnownItem('iCloud+ 2 TB Abo', icloud)).toBe('iCloud+ 2 TB');
    expect(pickKnownItem('iCloud+ 200 GB', icloud)).toBe('iCloud+ 200 GB');
  });
});

describe('rankItems: the vendor\'s wordings, the most used first', () => {
  it('counts the items of every spelling of the vendor, the company behind it included', () => {
    const stored = [
      { vendor: 'Apple', item: 'iCloud+ 2 TB' },
      { vendor: 'Apple Distribution International Ltd.', item: 'iCloud+ 2 TB' },
      { vendor: 'Apple Distribution International Ltd.', item: 'Apple Music' },
      { vendor: 'Apple Cafe', item: 'Kaffee' },
    ];
    expect(rankItems('Apple', stored)).toEqual(['iCloud+ 2 TB', 'Apple Music']);
  });

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
  it('is the first word without the legal form, which every spelling of the vendor starts with', () => {
    expect(vendorSearchWord('Example Video Tools Inc.')).toBe('Example');
    expect(vendorSearchWord('Apple Distribution International Ltd.')).toBe('Apple');
    expect(vendorSearchWord('Hetzner Online GmbH')).toBe('Hetzner');
  });

  it('is the second word where the first is too short to name a vendor alone', () => {
    expect(vendorSearchWord('A2 Hosting LLC')).toBe('Hosting');
  });

  it('is null where nothing is long enough', () => {
    expect(vendorSearchWord(null)).toBeNull();
    expect(vendorSearchWord('AB')).toBeNull();
    expect(vendorSearchWord('GmbH')).toBeNull();
  });
});

describe('vendorSpelling: a reading takes the shortest stored spelling of its vendor', () => {
  const apple = [
    ...Array.from({ length: 5 }, () => ({ vendor: 'Apple', item: 'iCloud+ 2 TB' })),
    { vendor: 'Apple Distribution International Ltd.', item: 'iCloud+ 2 TB' },
    { vendor: 'Apple App Store', item: 'App' },
  ];

  it('the company behind the brand, or what the brand was bought as, comes to the brand', () => {
    expect(vendorSpelling('Apple Distribution International Ltd.', apple)).toBe('Apple');
    expect(vendorSpelling('Apple iCloud', apple)).toBe('Apple');
    expect(vendorSpelling('APPLE', apple)).toBe('Apple');
    const telekom = [{ vendor: 'Telekom', item: 'Mobilfunk' }, { vendor: 'Telekom Deutschland GmbH', item: 'Mobilfunk' }, { vendor: 'Telekom Deutschland GmbH', item: 'Festnetz' }];
    expect(vendorSpelling('Telekom Deutschland GmbH', telekom)).toBe('Telekom');
    expect(vendorSpelling('Adobe Systems Software Ireland Ltd', [{ vendor: 'Adobe', item: 'Creative Cloud' }])).toBe('Adobe');
    expect(vendorSpelling('amazon.de', [{ vendor: 'Amazon', item: 'Kabel' }])).toBe('Amazon');
    expect(vendorSpelling('Anthropic, PBC', [{ vendor: 'Anthropic', item: 'Claude Pro' }])).toBe('Anthropic');
    expect(vendorSpelling('Example Tools via Paddle.com', [{ vendor: 'Example Tools', item: 'Lizenz' }])).toBe('Example Tools');
  });

  it('the same name in another case or with the legal form takes the spelling used most', () => {
    const stored = [{ vendor: 'freenet', item: null }, { vendor: 'freenet', item: null }, { vendor: 'Freenet', item: null }];
    expect(vendorSpelling('FREENET', stored)).toBe('freenet');
    expect(vendorSpelling('A2 Hosting LLC', [{ vendor: 'A2 Hosting', item: 'Webhosting' }])).toBe('A2 Hosting');
  });

  it('another business that starts with the same name stays as read', () => {
    // A template shop is not the note-taking app, though its name starts with it.
    expect(vendorSpelling('Notion Cafe', [{ vendor: 'Notion', item: 'Notion Plus Plan' }])).toBeNull();
    expect(vendorSpelling('Deutsche Post', [{ vendor: 'Deutsche Bahn', item: 'Fahrkarte' }])).toBeNull();
    expect(vendorSpelling('Applebee', apple)).toBeNull();
    expect(vendorSpelling('DB Schenker', [{ vendor: 'DB', item: 'Fracht' }])).toBeNull();
  });

  it('a reading is never lengthened to a longer stored name', () => {
    expect(vendorSpelling('Apple', [{ vendor: 'Apple Distribution International Ltd.', item: 'iCloud+ 2 TB' }])).toBeNull();
  });

  it("a meal's restaurant is never the spelling; nothing read, nothing stored, nothing taken", () => {
    expect(vendorSpelling('Example Cafe GmbH', [{ vendor: 'Example Cafe', item: null, meal: true }])).toBeNull();
    expect(vendorSpelling(null, apple)).toBeNull();
    expect(vendorSpelling('Apple', [])).toBeNull();
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
