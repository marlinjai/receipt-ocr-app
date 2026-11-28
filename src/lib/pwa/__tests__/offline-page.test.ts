// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { OFFLINE_DB_NAME, OFFLINE_DB_VERSION, OFFLINE_KEY, OFFLINE_MAX_AGE_MS, OFFLINE_STORE_NAME, openOfflineStore, type OfflineReceipt } from '@/lib/offline/receipts-db';

const SOURCE = readFileSync(path.join(process.cwd(), 'public', 'offline.html'), 'utf8');
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(SOURCE)![1];
const BODY = /<body>([\s\S]*?)<script>/.exec(SOURCE)![1];

function receipt(i: number, extra: Partial<OfflineReceipt> = {}): OfflineReceipt {
  return { id: `r${i}`, date: `2026-11-${String((i % 28) + 1).padStart(2, '0')}`, name: `Beleg ${i}`, vendor: null, gross: i + 0.5, currency: 'EUR', eur: i + 0.5, category: 'Lebensmittel', status: 'Offen', assignment: null, ...extra };
}

let factory: IDBFactory;

async function openPage(receipts: OfflineReceipt[] | null, savedAt = Date.now() - 60_000) {
  if (receipts) await openOfflineStore(factory).write({ workspaceId: 'ws-a', company: 'Firma A', receipts, savedAt }, 0);
  document.body.innerHTML = BODY;
  new Function(SCRIPT)();
}

const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
const rows = () => document.querySelectorAll('#list li');

beforeEach(() => {
  factory = new IDBFactory();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = factory;
});

describe('public/offline.html: the receipts list kept on this device', () => {
  it('reads the same database as the app', () => {
    expect(SOURCE).toContain(`var LIST_DB_NAME = '${OFFLINE_DB_NAME}';`);
    expect(SOURCE).toContain(`var LIST_DB_VERSION = ${OFFLINE_DB_VERSION};`);
    expect(SOURCE).toContain(`var LIST_STORE_NAME = '${OFFLINE_STORE_NAME}';`);
    expect(SOURCE).toContain(`var LIST_KEY = '${OFFLINE_KEY}';`);
    expect(SOURCE).toContain(`var MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;`);
    expect(7 * 24 * 60 * 60 * 1000).toBe(OFFLINE_MAX_AGE_MS);
  });

  it.each([
    ['saved more than a week ago (a device left behind)', () => Date.now() - OFFLINE_MAX_AGE_MS - 1000],
    ['saved while the clock ran ahead', () => Date.now() + 60 * 60 * 1000],
  ])('shows no list %s', async (_label, savedAt) => {
    await openPage([receipt(1)], savedAt());
    await new Promise((r) => setTimeout(r, 20));
    expect($('#saved').hidden).toBe(true);
  });

  it('shows the first 100 receipts with company and time saved, then the rest on request', async () => {
    await openPage(Array.from({ length: 150 }, (_, i) => receipt(i)));
    await expect.poll(() => rows().length).toBe(100);
    expect($('#saved').hidden).toBe(false);
    expect($('#saved-meta').textContent).toContain('Firma A');
    expect($('#count').textContent).toBe('150 Belege');
    expect($('#more').textContent).toBe('Weitere 50 von 50 zeigen');
    $('#more').click();
    expect(rows().length).toBe(150);
    expect($('#more').hidden).toBe(true);
  });

  it('searches all receipts, also beyond the first 100, by name, date and amount', async () => {
    await openPage([...Array.from({ length: 120 }, (_, i) => receipt(i)), receipt(999, { name: 'Bäckerei Huber', date: '2025-03-07', gross: 7.2 })]);
    await expect.poll(() => rows().length).toBe(100);
    const search = $('#search') as HTMLInputElement;
    for (const query of ['bäckerei', '07.03.2025', '7,2']) {
      search.value = query;
      search.dispatchEvent(new Event('input'));
      expect(rows().length).toBe(1);
      expect(rows()[0].textContent).toContain('Bäckerei Huber');
      expect($('#count').textContent).toBe('1 Treffer von 121');
    }
  });

  it('shows markup from a receipt as text and never builds it', async () => {
    await openPage([receipt(1, { name: '<img src=x onerror="window.hit=1">', vendor: '<b>Händler</b>' })]);
    await expect.poll(() => rows().length).toBe(1);
    expect(document.querySelector('#list img, #list b')).toBeNull();
    expect(rows()[0].textContent).toContain('<img src=x');
  });

  it('shows no list when none is kept (never signed in here, or signed out)', async () => {
    await openPage(null);
    await new Promise((r) => setTimeout(r, 20));
    expect($('#saved').hidden).toBe(true);
    expect(rows().length).toBe(0);
  });

  it('back online with the list open: offers the way back instead of leaving the page', async () => {
    await openPage([receipt(1)]);
    await expect.poll(() => rows().length).toBe(1);
    window.dispatchEvent(new Event('online'));
    expect($('#back').hidden).toBe(false);
  });
});
