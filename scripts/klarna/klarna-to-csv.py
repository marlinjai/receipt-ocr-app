"""Turns klarna-raw.json (from klarna-web-export.js) into the purchase list the receipts app
imports as `klarna_csv`, keeping only purchases not in the files already imported.

    python3 -I klarna-to-csv.py ~/.dev-browser/tmp/klarna-raw.json out.csv imported1.csv [imported2.csv ...]

A purchase counts as imported when its payment reference or order reference appears in one of
those files. A purchase the shop has not charged yet is written with the status
"In Bearbeitung", which the importer skips until a later export shows it charged.
"""
import csv
import json
import re
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

FIELDS = ['created_date', 'created_time', 'activated', 'settled', 'amount', 'currency', 'merchant', 'items',
          'payment_method', 'status', 'payment_reference', 'statement_number', 'category', 'purchase_type',
          'card', 'source', 'timezone']
raw_path, out_path, *imported = sys.argv[1:]
known = set()
for path in imported:
    for row in csv.DictReader(open(path, newline='')):
        known.update({row.get('payment_reference', ''), row.get('statement_number', '')})
known.discard('')
berlin = ZoneInfo('Europe/Berlin')
today = datetime.now(berlin).date().isoformat()
rows = []
for r in {x['krn']: x for x in json.load(open(raw_path))['rows']}.values():
    if r['ref'] in known or r['order'] in known:
        continue
    at = datetime.fromisoformat(r['createdAt'].replace('Z', '+00:00')).astimezone(berlin)
    amount = re.fullmatch(r'([\d.]+,\d{2})\s*€', r['amount'].replace('\xa0', ' ').strip())
    if not amount:
        sys.exit(f'Unexpected amount {r["amount"]!r} for {r["merchant"]} (another currency?)')
    rows.append({
        'created_date': at.date().isoformat(), 'created_time': at.strftime('%H:%M'), 'activated': '', 'settled': '',
        'amount': amount.group(1).replace('.', '').replace(',', '.'), 'currency': 'EUR', 'merchant': r['merchant'].strip(),
        'items': '', 'payment_method': r['method'],
        'status': 'In Bearbeitung' if 'UNCAPTURED' in r['statuses'] else 'captured',
        'payment_reference': r['ref'], 'statement_number': r['order'], 'category': '',
        'purchase_type': r['purchaseType'], 'card': '', 'source': f'klarna-web-{today}', 'timezone': 'Europe/Berlin',
    })
rows.sort(key=lambda r: (r['created_date'], r['created_time']))
with open(out_path, 'w', newline='') as f:
    writer = csv.DictWriter(f, fieldnames=FIELDS)
    writer.writeheader()
    writer.writerows(rows)
print(f'{len(rows)} new purchases written to {out_path}')
