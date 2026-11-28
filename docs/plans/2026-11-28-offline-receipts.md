---
title: Offline view of the receipts in the installed app
summary: The offline page of the installed app lists the receipts of the company last open on the device, read only and text only. The app saves the list to IndexedDB from a new session-only route and reads it again for the same company only once the saved one is an hour old (a company switch reads it at once); the service worker still caches nothing but the offline page. Signing out or a refused session deletes the list.
type: plan
status: completed
date: 2026-11-28
tags: [receipts, pwa, offline]
---

# Offline view of the receipts in the installed app

Asked by Marlin on 2026-11-28 ("Offline-Ansicht der Belege in der installierten App", yes),
after the performance, installed app and navigation review
(`docs/plans/2026-11-26-receipts-perf-pwa-ux-review.md`).

## What it decides

Without a connection the installed app shows today only `/offline.html`, where a photo can be
taken into the capture queue. From now on that page also lists the receipts of the company last
open on this device: date, name, vendor, amount, category, status and assignment, with a search
and the time the list was saved. Read only: nothing is changed offline except the existing photo
queue.

## How, and why this way

The service worker keeps its rule: it never stores or serves application pages or `/_next/`
files (the worker removed in March 2026 did, and kept browsers on old scripts after deploys).
So the offline list is not a cached app page. It is data:

1. **Server**: `GET /api/receipts/offline` returns a compact list of the active company's
   receipts (`src/lib/offline/snapshot.ts`, built on `tableContext` and `allReceiptRows`, the
   same reads as the review queue; the status options are read there only, so no other page
   gets a query more). No OCR text, no files. Session required, company from the session only,
   `no-store`, measured in the `[timing]` log. 401 or 403 when the session is refused, 503 when it
   cannot be checked.
2. **App**: `OfflineSnapshot`, mounted once in the `/app` layout inside the store provider (so
   it starts again on a company switch), saves the list to IndexedDB (`receipts-offline`) a few
   seconds after the page settled, when the saved one is older than an hour or belongs to another
   company, and again when the app comes back to the foreground after an hour. The hour is the freshness
   rule: a saved list of the same company younger than that is not read again. A company switch
   reads earlier, and so does a device without a saved list (first time, or deleted), a list dated
   ahead of the clock, and the next occasion after a save that failed. Never during a page load. A refused session (401, 403) deletes the
   list on the device; a network failure, a 503 or a server error keeps it. An answer for another
   company, or one that arrives after a company switch or a sign-out, is never written.
3. **Offline page**: `public/offline.html` stays self-contained (no app script), reads the
   saved list and renders it with `textContent` only, 100 rows at a time with a search over all.
   Coming back online while the list is open offers a button back to the app instead of leaving
   at once. The service worker's version goes up so installed apps fetch the new page.

## Protections and who they protect against

- **The saved list is deleted on sign-out** (`signOutWithPush`), **and when the server refuses
  the session** (expired, signed out elsewhere, removed from the company). Against: the next
  person who uses the same browser. `/offline.html` is a public file, so without it the page
  would show the receipts without any session. A save still on its way is stopped first, no save
  starts in that tab afterwards, and the list is deleted once more right before leaving. Every
  deletion is counted next to the list, and a save writes only if the count did not change since it
  started, so a sign-out in another tab wins too. The no-access page's sign-out does the same.
- **The service worker deletes the list when a page of the app answers with a redirect.** The
  app's own pages never redirect; the middleware does when the session expired, was ended at
  auth.lumitra.co or in another app, or the access was removed, and then no app code runs that
  could get a 401. Against: the same next person.
- **The offline page shows no list saved more than 7 days ago, or saved with a clock ahead.**
  Against: a browser where none of the above ran (a session that ended while the app was closed,
  never opened online again). The device does not know when the session ends (auth-brain sends no
  expiry), so this bounds it.
- **An answer for another company than the page shows deletes the list.** Against: a person
  removed from a company whose installed app stayed open.
- **One company at a time**: a switch replaces the list, and a list of another company is never
  shown as current. Against: nobody; it keeps the offline view right.
- **Rendered as text, never as HTML.** Against: a vendor name or file name read from a receipt
  that contains markup (receipt text comes from outside).
- Not built: encryption on the device. The person holding an unlocked device with a session
  sees the same receipts in the app anyway.

## Decided, say so if you disagree

- **Text only, no receipt images offline.** Images would cost hundreds of megabytes on the phone
  for a few thousand receipts. Can follow if wanted.
- **Lists older than 7 days are not shown offline.** A week without a connection is covered; a
  device left behind stops showing receipts a week after the app was last open online.
- **A company erasure does not reach copies on devices.** The server cannot delete IndexedDB in
  a browser. A copy goes the next time that browser opens the app (the session or the company is
  gone, so the list is deleted) and is never shown after 7 days.
- **An auth outage keeps the list**: the middleware answers it with 503 before the route runs.
- **Freshness of one hour**, and saved again after an upload (the next save after an hour picks
  it up). The page shows when the list was saved.
- Theme colour stays amber (Marlin, 2026-11-28).

## Tests

- The snapshot builder: receipts only (no groups), labels instead of option ids, missing values.
- The route: 401 without a session, the list of the session's company.
- The client: saves when stale or of another company, not when fresh, nothing when the read fails;
  sign-out deletes the list.
- `offline.html` executed in jsdom on a fake IndexedDB: the list, the search, markup shown as text,
  an empty or missing list, the names shared with the app compared by a test.

## Verified on production (2026-11-28)

Merged in #264 and deployed; checked with the headless browser, signed in:

- The service worker is version v4 and controls the page. Ten seconds after opening the dashboard
  the device held the list: 1,312 receipts, the ten fields above and nothing else.
- Offline, `/app/spending` showed the offline page with the list: "1312 Belege", 100 rows,
  "Weitere 100 von 1212 zeigen", the company and the time saved. A search for "2026" found 479, a
  search for nothing that exists found 0. Back online, the button to the app appeared.
- `GET /api/receipts/offline`: 0.67 to 1.35 s over three calls, 348 KB of JSON, sent gzip and
  `no-store`. Read in the background; for the same company again only once the saved list is an
  hour old (a company switch reads at once; the other exceptions are under "How, and why this way").
- Not tried on production: signing out (it would sign the automation profile out); the tests cover it.

