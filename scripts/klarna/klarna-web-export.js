// Reads every Klarna purchase the signed-in Klarna web app knows (completed and open payments)
// and writes them, with day, time, amount, merchant, payment reference and order reference,
// to klarna-raw.json in the dev-browser temp folder. Run in the visible automation Chrome,
// where the Klarna login lives:
//   dev-browser-auto --visible --timeout 170 run klarna-web-export.js
// Run it again until it prints "left 0": the app's sign-in token lasts only a few dozen
// requests, so each run takes a fresh one and reads at most 35 purchases. The token stays
// inside the page and is never printed. Turn the result into the importer's file with
// klarna-to-csv.py. A new export starts by deleting klarna-raw.json, so the list of purchases is
// fetched afresh; a purchase still reserved (not charged) is read again on every run until it is.
const reserved = (row) => (row.statuses || []).includes('UNCAPTURED');
const page = await browser.getPage('klarna-export');
const base = '/de/api/post_purchase_bff/post-purchase/feature';
let state = { krns: null, rows: [], errors: [] };
try { state = JSON.parse(await readFile('klarna-raw.json')); } catch { /* first run */ }

const tokenRequest = page.waitForRequest((r) => r.url().includes('/manage-payments/v1/'), { timeout: 30000 });
await page.goto('https://app.klarna.com/manage-payments', { waitUntil: 'commit' });
const all = await (await tokenRequest).allHeaders();
const headers = Object.fromEntries(Object.entries(all).filter(([k]) => k === 'authorization' || k === 'accept' || k.startsWith('x-klarna-')));

const result = await page.evaluate(async ({ headers, base, state }) => {
  let krns = state.krns;
  if (!krns) {
    const found = new Set();
    const collect = (o) => {
      if (typeof o === 'string') (o.match(/krn:ccs:transaction:[0-9a-f-]{36}/g) || []).forEach((k) => found.add(k));
      else if (o && typeof o === 'object') Object.values(o).forEach(collect);
    };
    collect(await (await fetch(`${base}/manage-payments/v1/completed`, { method: 'POST', headers, credentials: 'include' })).json());
    collect(await (await fetch(`${base}/manage-payments/v1/active`, { headers, credentials: 'include' })).json());
    krns = [...found];
  }
  const done = new Set(state.rows.filter((r) => !r.reserved).map((r) => r.krn));
  const todo = krns.filter((k) => !done.has(k)).slice(0, 35);
  const rows = [];
  const errors = [];
  for (const krn of todo) {
    const r = await fetch(`${base}/transaction-detail/v1/${encodeURIComponent(krn)}/initial-data?source=intern`, { headers, credentials: 'include' });
    if (r.status !== 200) {
      errors.push(`${krn} ${r.status}`);
      continue;
    }
    const j = await r.json();
    const section = (name) => (j.sectionsList || []).find((s) => s.sectionName === name);
    const head = section('TransactionHeaderSection')?.sectionData?.data;
    const pay = section('PaymentsSection')?.sectionData?.data?.data;
    const items = section('LineItemsSection')?.sectionData?.data?.rows || [];
    rows.push({
      krn,
      createdAt: j.createdAt,
      statuses: j.transactionStatuses,
      merchant: head?.brand?.displayName || j.description,
      amount: head?.mainAmount?.text,
      method: head?.rows?.[0]?.columns?.[1]?.text || '',
      ref: (pay?.details || []).find((d) => d.label?.value === 'Zahlungsreferenz')?.title?.value || '',
      order: items.find((x) => x.type === 'KLARNA_ORDER_REFERENCE')?.params?.value || '',
      purchaseType: items.find((x) => x.type === 'PURCHASE_TYPE')?.params?.inStoreDescription || '',
    });
    await new Promise((s) => setTimeout(s, 200));
  }
  return { krns, rows, errors };
}, { headers, base, state: { ...state, rows: state.rows.map((r) => ({ ...r, reserved: reserved(r) })) } });

// A row read again replaces the one before (a reserved purchase that is charged now).
const fresh = new Set(result.rows.map((r) => r.krn));
state = { krns: result.krns, rows: [...state.rows.filter((r) => !fresh.has(r.krn)), ...result.rows], errors: result.errors };
await writeFile('klarna-raw.json', JSON.stringify(state));
const left = state.krns.length - state.rows.filter((r) => !reserved(r)).length;
console.log('purchases', state.krns.length, 'read', state.rows.length, 'reserved', state.rows.filter(reserved).length, 'failed this run', result.errors.length, 'left', left);
