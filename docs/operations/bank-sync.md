---
title: Live bank connection (Enable Banking) and its daily fetch
summary: How the live bank connection of the payments tab is switched on, which settings it reads, how each account is connected, and the daily scheduled fetch that is described here but not created.
type: documentation
tags: [operations, bank, enable-banking, payments]
projects: [receipt-ocr-app]
date: 2026-10-16
---

# Live bank connection (Enable Banking) and its daily fetch

The payments tab can read an account live through Enable Banking (an aggregator that
reads bank accounts under the European payment services directive, PSD2). It is
**off** until the server holds the settings below. Off means: the payments tab shows
a quiet note and every account keeps its file importer, the bank actions refuse, and
the daily route answers 503. Plan: `docs/plans/2026-10-07-finance-tax-dashboard-and-advisory.md`,
section "Reality: the live bank connection (2026-10-16)".

The scheduled task is **not created** by the change that built this. Creating it is a
production change; the steps are below.

## Settings (Infisical, receipts project, production, read by name only)

| Name | Needed for | What it is |
|---|---|---|
| `BANK_FEED_ENABLED` | everything | The switch: the feature is on only when this is exactly `true`. |
| `ENABLE_BANKING_APP_ID` | everything | The application id from the Enable Banking control panel. It is the key id (`kid`) of every signed JSON Web Token (JWT). |
| `ENABLE_BANKING_PRIVATE_KEY` | everything | The application's private key (Rivest-Shamir-Adleman, RSA) as text in the Privacy-Enhanced Mail (PEM) format. Line breaks may be written as `\n`. Never leaves the server. |
| `ENABLE_BANKING_REDIRECT_URL` | everything | `https://receipts.lumitra.co/api/bank/callback`. Must be registered on the application exactly like this. |
| `BANK_SYNC_SECRET` | the daily route only | The shared secret of the Hash-based Message Authentication Code (HMAC) the scheduled task signs with. |

When the switch is on but a setting is missing, the feature stays off; `bankConfig()`
in `src/lib/tax/payments/bank/config.ts` lists the missing names (names only).

## Activation

1. **Application.** In the Enable Banking control panel, use the registered application
   ("Lumitra Receipts", restricted production) or register one. Its key pair: let the
   control panel generate it, or generate one locally and upload the public part. Put the
   private key into `ENABLE_BANKING_PRIVATE_KEY` and the id into `ENABLE_BANKING_APP_ID`
   (the finance plan says both already live in Infisical under `ENABLE_BANKING_*`; check
   the names match the table, rename rather than copy). Add the redirect address above to
   the application's allowed redirect addresses.
2. **Restricted production** serves only accounts linked to the application. If a consent
   ends with "the bank gives this account not out" (`ASPSP_ACCOUNT_NOT_ACCESSIBLE`) or with
   no account, link the account to the application in the control panel first and start
   again.
3. **Secrets.** Set `ENABLE_BANKING_REDIRECT_URL` and `BANK_FEED_ENABLED=true`. Generate
   `BANK_SYNC_SECRET` server-side (the secrets proxy's `copy_secret` with `op=generate`), so
   the value never enters a transcript. Restart the app (it reads secrets on start).
4. **Consent per account**, each on its own: Finanzen, tab "Zahlungen", the account's
   "Live mit der Bank verbinden". The search box lists the institutions the interface
   offers for Germany (read live from `GET /aspsps`); the one named in the account's label
   is preselected. The browser goes to the bank and comes back to the payments tab. When the
   bank released several accounts, the tab asks which one belongs to this account. Then
   "Jetzt abholen" fetches the last 89 days.
5. **Check before the schedule.** Through the secrets proxy with the receipts production
   secrets injected, compute `sha256=` plus the hex HMAC-SHA256 (Secure Hash Algorithm 256) of
   the body `{"ts":<the current Unix time in seconds>}` under `BANK_SYNC_SECRET` and POST that body to `https://receipts.lumitra.co/api/internal/bank-sync`
   with the header `x-lumitra-erasure-signature` (declared in `src/lib/erasure-signature.ts`).
   Never print the secret or the signature. Expect 200 and per-connection counts; a second
   call right after adds nothing. Check that a missing signature answers 401, and that the
   same signed body sent again answers 409 (and 401 after five minutes): a signed request
   runs once.
6. **Scheduled task** (Coolify, on the receipts application, once a day, for example 06:30
   Europe/Berlin), run inside the container where `BANK_SYNC_SECRET` is in the environment:

   ```sh
   node -e "const c=require('node:crypto');const b=JSON.stringify({ts:Math.floor(Date.now()/1000)});const s=c.createHmac('sha256',process.env.BANK_SYNC_SECRET).update(b).digest('hex');fetch('http://localhost:3000/api/internal/bank-sync',{method:'POST',headers:{'content-type':'application/json','x-lumitra-erasure-signature':'sha256='+s},body:b,signal:AbortSignal.timeout(280000)}).then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)}).catch(e=>{console.error(e.name);process.exit(1)})"
   ```

   The answer holds counts only (connections, added, failed, and per connection its id,
   status and count), never bank data. Confirm the next run and the execution history.

**Once a day is the promise.** The payment services directive limits the fetches a third
party may make without the person present to a few per day and account; the daily run and
the person's own "Jetzt abholen" stay well inside that.

## What a run does

`syncAllConnections` in `src/lib/tax/payments/bank/service.ts`: every active connection of
every company, one after the other. Per connection: the booked movements from five days
before the last booked day it saw (the first time: 89 days back) up to today, all pages,
handed to the normal payment import as the bank interface's list. A day belongs to the
source that brought it first, so an account also fed from files keeps every movement once.
A fetch that brings nothing new leaves no import behind. After a fetch that added payments,
the spending checks (missing receipts, budgets) run for that company; their failure is only
logged.

| What happens | The connection afterwards |
|---|---|
| Consent ran out, or the bank says the session expired | `expired`: the account shows "Verbindung abgelaufen am ..., bitte erneuern" with its last complete day; data stays. |
| The person ended the consent at the bank | `revoked`, same as above. |
| Rate limit | stays `active`, the error is shown, the next run tries again. |
| Bank down, time-out, unreadable answer | stays `active`, the error is shown, the next run tries again. |

## Stopping it

Remove `BANK_FEED_ENABLED` (or set it to anything but `true`) and restart: the route answers
503, the buttons disappear, nothing is deleted. A single account is disconnected in the tab
("Trennen"): the session is closed at the bank, the connection is removed, its payments stay.
