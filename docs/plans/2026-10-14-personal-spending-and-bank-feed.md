---
title: Personal spending, the live bank connection and the missing-receipt loop
summary: The owner decided on 2026-10-14 that private spending lives in the receipts app (company "marlinjai"), with an overview, a clean split for tax, budgets and warnings, a document for every purchase, and a live bank connection that finds or asks for the receipt of every payment. This plan records the decisions and the loop that does it.
type: plan
status: in-progress
tags: [receipts, personal-spending, bank, payments, notifications, budgets]
projects: [receipt-ocr-app]
date: 2026-10-14
---

# Personal spending, the live bank connection and the missing-receipt loop

## Decisions (owner, 2026-10-14, on the decision page of 2026-10-13)

1. **What it does:** an overview of where the money goes, a clean separation of private and
   business for tax, and budgets with warnings.
2. **Where it lives:** in the receipts app, company "marlinjai" for the private side. No second
   system and no second copy of the bank data.
3. **Documents:** a document for every private purchase, not only the tax-relevant ones.
4. **Categories:** the twelve that the existing spending ledger uses (software, AI and hosting;
   transport; groceries and drugstore; eating out and coffee; shopping and household; housing and
   utilities; loans, leasing and credit; leisure and sport; fees and interest; transfers to
   people and other accounts; cash withdrawals; unclear).
5. **Rhythm:** a live bank connection (named Enable Banking in the finance plan), not monthly
   files. The monthly file import stays as the way to catch up and as the fallback.
6. **The loop (the owner's own words, condensed):** whenever a payment arrives and no receipt for
   it exists, the app works out what the payment was for from its reference and details and
   fetches the invoice itself, from the mailbox expenses@marlinjai.com or from the vendor's
   login. If it cannot, it notifies the owner to upload the receipt right away.

## The loop, as steps

For each new payment of a private or business account, in this order, stopping at the first that
settles it:

1. **Is it a transfer between own accounts, a fee, a loan instalment, cash?** Those need no
   receipt (rules and answers on counterparties already exist in the payments tab).
2. **Does a receipt already exist?** Today the payments tab proposes an uploaded receipt by
   amount and day alone, and a person confirms it (`proposeMatches` is given no vendor data for
   euro receipts); only the estimated-amount proposals for foreign-currency receipts use the
   vendor. Matching on the vendor as well is part of this plan and needs the receipt's vendor
   passed to the matcher first. A confirmed match is linked; the receipt is not asked for again.
3. **Is the invoice in the mailbox?** Look in expenses@marlinjai.com for a message from that
   vendor around the day with a matching amount or reference. Take its attachment into the
   normal upload path, so the reader and the vendor rules run as for any receipt.
4. **Can the vendor's own account give it?** Only for vendors that offer a download after a
   login or an interface key. Stored logins are secrets and the owner's decision per vendor
   (see "Open"). Not built in the first version.
4b. **Fetch through the owner's signed-in browser** (the owner's idea of 2026-10-15; designed
   below, not built). For a recurring payment whose invoice did not arrive by mail.
5. **Otherwise ask.** A notification to the owner with the payment (vendor, amount, day) and a
   one-tap way to photograph or upload the receipt. The payment then sits in the open checks
   until a receipt is linked or the owner says "no receipt exists" (with the reason).

A payment that has been answered once is never asked again, and a vendor whose invoices always
arrive by mail is handled by step 3 without a notification.

## Owner's answers of 2026-10-15

- **Notification channel:** push to the installed phone app by default, e-mail as the fallback
  whenever push is not possible (no subscription on the phone, or delivery failed).
- **Vendor logins (step 4):** none for now. Step 4 stays unbuilt.
- **Step 4b, below:** his idea, to be designed now and built later.

## Design: step 4b, fetch through the owner's signed-in browser (not built)

The automation Chrome on the owner's own machine is already signed in to vendors such as iCloud+
or Cursor. For a payment the app knows as recurring whose invoice did not arrive by mail, that
browser could download the invoice. No password is ever stored in the app; the existing browser
session is the only credential, and it never leaves the owner's machine.

- **Why a worker:** the app runs on a server and cannot reach a browser on the owner's machine. A
  small worker on that machine polls the app for fetch jobs (outbound only, so nothing on the
  machine is exposed), runs them, and uploads the result through the normal upload path, so the
  reader and the vendor rules run as for any receipt. It authenticates as a machine identity of
  the receipts app with one permission: take jobs and upload receipts for its own workspace.
- **Job queue:** a table of fetch jobs in the app (workspace, payment, vendor key, period, status
  `queued`, `running`, `done`, `session_expired`, `failed`, attempts, the resulting receipt). The
  loop creates a job only for a vendor that has a recipe and only after step 3 found nothing. A
  job is taken by one worker at a time (a lease with an expiry, so a crashed run is retried), and
  a payment has at most one open job.
- **Per-vendor fetch recipe:** a recipe lives in the worker's code, reviewed like any code, one per
  vendor: how to open the vendor's billing page, find the invoice for a period, and download it.
  The app only knows which vendor keys have a recipe (the worker reports its list).
- **Serial rule:** browser work on that machine is strictly one script at a time, machine-wide
  (the dev-browser daemon runs one script at a time; parallel runs only queue and starve other
  sessions). The worker therefore takes one job, finishes it, and only then takes the next;
  it never runs two, and it waits while another script holds the browser.
- **Expired session:** when the vendor shows a sign-in page instead of the billing page, the job
  ends as `session_expired`, nothing is retried, and the loop goes on to step 5: the owner gets
  the normal missing-receipt notification, with the note that signing in to that vendor in the
  automation browser again lets the next payment be fetched by itself.
- **Security:** a job names only a vendor key and a period (a month), never a web address, a
  selector or a script. The worker refuses a job whose vendor it has no recipe for. So a
  compromised app or a forged job can at most make the worker fetch an invoice of a known vendor
  for some month; it can never steer the signed-in browser anywhere else. The worker uploads
  only files it downloaded itself, and only to the workspace its identity belongs to.

## What the budgets are

A monthly limit per category (and per vendor where wanted), the spending so far this month from
the payments, and a warning when a limit is passed or is certain to be passed at this pace. The
warning goes through the same channel as the missing-receipt notification.

## Build order

1. The overview of private spending from the payments the app already holds (categories as
   above, month and year, private versus business), under company "marlinjai". This needs no new
   connection.
2. The loop's steps 1 to 3 and 5 on the payments that are already imported, with a place for the
   notification (see "Open").
3. The live bank connection, so step 2 to 5 run on new payments as they happen.
4. Budgets and warnings.
5. Vendor logins (step 4), per vendor, once the owner has decided which.

## Open

- **Where the notification goes.** The app is installed on the phone (the capture screen), so a
  push message there is the natural channel; the owner's chat or e-mail are the alternatives.
  The owner's choice.
- **Which vendors may be fetched with a stored login.** Each one is a secret held by the system
  and a legal and safety decision of the owner. None until he names them.
- **Budget limits.** Decided by the coordinator on 2026-10-15: the default of a category is the
  owner's own twelve-month average from the payments, and he edits every number in the app.
- **The bank connection needs the owner's consent at each bank, repeated periodically.** Which
  accounts: the ledger holds four (Tomorrow, N26, Klarna, Advanzia) plus the payment service.
  Decided by the owner on 2026-10-16: all five are tried live, each on its own, with the file
  importers as the fallback (see build order 3 below).

## Reality

### Build order 1, the overview (2026-10-15)

- Page `/app/spending` ("Ausgaben", linked from the header of every app page), for the active
  company only: total, private, business and "not assigned" for a year or one month, the year
  month by month, the twelve categories, the unclear counterparties, and every payment with its
  category and where the category came from.
- Categories (`src/lib/spending/rules.ts`), first hit wins: an own account or a transfer between
  own accounts is "transfers" and is not counted as spending; a category the owner gave the
  counterparty; a fee by its kind; words in the name or text (cash, loans and fees first, then
  brand and trade words, never a person); otherwise "unclear", shown as its own list.
- Private or business comes only from what was said in the payments tab (a counterparty answered
  private or business, or a payment marked private), never from the company the payments were
  imported under: one bank account carries both. Unanswered is shown as such.
- One new table, `spending_category_answers` (migration 0020, additive): the category the owner
  gives a counterparty, applied to all its payments, taken back by deleting it. An unclear
  counterparty can also be answered "own account" right there (a credit card paid off from the
  bank): that is the payments tab's own answer, so the money is not counted twice.
- Brand words that are also surnames or ordinary invoice words ("mueller", "otto", "netto") are
  matched in the counterparty's name only, never in the payment's text.
- Payments are read only through the payments service's own read (`loadPayments`). The one
  write into the payments area is the own-account answer, through the payments service's public
  `setCounterpartyTreatment`; it never overwrites a business or private answer (that is changed
  in the payments tab), and it can be taken back on the page.
- Open question for the coordinator: payments are imported per company. If the bank files are
  imported under Whiz-Art Media, the overview under "marlinjai" stays empty; the overview itself
  works under whichever company holds them.

### Build order 2, the loop's steps 1, 2 and 5 (2026-10-16)

- The state of every payment is worked out on read (`src/lib/spending/loop.ts`), first hit
  wins: linked to a receipt; step 1, needs none (own transfer, income, refund, fee, loan, cash,
  money to a person); a person said "no receipt exists" with the reason; step 2, unlinked receipts
  of the same company fit by vendor (named in the counterparty or the text, or paired by an earlier
  link), exact amount (within 8 percent for a foreign-currency estimate) and a receipt day from 60
  days before to 5 days after the payment, and a person confirms one (the link goes through the
  payments service's `linkPayment`); step 5, otherwise the receipt is missing. Private purchases
  need a receipt too (decision 3).
- Stored: only the "no receipt" answer (`spending_receipt_answers`), the notification setting
  (`spending_settings`) and the notifications (`spending_notifications`), migration 0024, additive.
- Notifications go through a port (`src/lib/spending/notify/port.ts`): always into the in-app queue
  on the spending page, then push, then e-mail (the owner's answer). Each payment is notified about
  at most once, ever, and only when it was booked within the last 14 days, so importing a year of
  history sends nothing. A failed delivery is retried on later runs, at most three tries in all.
  E-mail goes through Resend over the Hypertext Transfer Protocol (HTTP) and is off until the server holds `RESEND_API_KEY`,
  `SPENDING_MAIL_FROM` and `APP_BASE_URL`. Push is prepared behind the port and reports itself
  unavailable until the push change (subscriptions from the phone, the server's key pair) lands.
- A run (`runReceiptLoop`) takes settled payments out of the queue, retries failed deliveries and
  notifies about new missing receipts, at most ten per run (the rest on the next run). It runs
  after every payment file import (from the finance action, logged and never failing the import)
  and from "Jetzt prüfen" on the page; the live bank feed should call it the same way.
- Step 3 (the mailbox): see below.

### Build order 2, step 3: the expenses mailbox (2026-10-16)

- A mailbox port (`src/lib/spending/mailbox/port.ts`) with a Gmail adapter (`gmail.ts`), read-only,
  with plain `fetch`. The mailbox belongs to exactly one company (`SPENDING_MAILBOX_WORKSPACE_ID`);
  for every other company the step is off, so no other company ever sees its mail.
- A run searches the mailbox for each recent payment whose receipt is missing: mail delivered to
  the expenses address, with an attachment, from 14 days before to 3 days after the payment,
  naming the counterparty (its normalized name and the vendors earlier links paired it with) and
  the amount ("29,99" or "29.99"). A payment without a name is not searched: an amount alone finds
  any mail with that number. A search that found nothing is repeated a day later, at most three
  times; a failed search uses up no try. At most ten searches and twenty seconds per run. A revoked
  grant stops the run's searches and is reported on the page; a rate limit only pauses them.
- Found attachments (PDF or image) are stored only as a pointer (message, place, name), never
  their content (`spending_mail_searches`, `spending_mail_candidates`, migration 0028, additive);
  finds of a payment whose import was undone go with it. The payment shows "Im Postfach" with
  "Als Beleg übernehmen" and "Nicht die Rechnung" (set aside for good; the payment may be searched
  again). Taking over: the browser fetches the attachment through
  `/api/spending/mail-attachment/<id>` (write permission, the active company's only, at most 20
  MB), runs the normal upload pipeline with it, and links the new receipt to the payment, because
  the owner chose the mail for it.
- Deviation from the plan, decided: a payment whose invoice was found gets one "Rechnung im
  Postfach" message (also when the find comes on a later search, after its "Beleg fehlt"
  message), because taking the attachment over is one tap by the owner. A server-side upload
  without a tap would need a server-side version of the upload pipeline, which belongs to the
  upload path, not to this lane.
- Off until the server holds the five settings named in the README ("Ausgaben-Postfach"): a Google
  Open Authorization (OAuth) client with the read-only mail scope, a refresh token granted once by
  the owner of the mailbox the expenses address delivers into, the address, and the company.

### Push to the phone, the owner's default channel (2026-10-16)

- The push channel behind the notification port (`src/lib/spending/notify/push.ts`) sends every
  message to each device that switched push on for the company, signed with the server's Voluntary
  Application Server Identification (VAPID) key pair and encrypted per device by the `web-push`
  library. When no device has push, or every delivery failed, the port falls back to e-mail, as the
  owner decided.
- A device belongs to the person who switched it on and gets messages only while that person
  renewed it within 7 days (every page of the app renews it while push is on): a person who lost
  access stops getting the company's messages within a week, and signing out switches push off on
  the device at once. When the browser gives the device a new push address on its own, the
  service worker reports old and new and the person's rows move along. Rows not renewed for 90
  days are deleted. Only addresses of the known push services are
  accepted (the server never sends to an address someone typed), with keys of the sizes browsers
  make. A device the push service reports gone is forgotten, and so is one that failed ten times
  in a row. Wrong keys on the server keep push off instead of failing every device.
- On the spending page ("Wie benachrichtigt wird") each device switches push on or off; it counts
  as on only once the server stored it, and switching off in one company keeps the browser's
  subscription when another company of the same person still uses it. The service worker shows the
  message and opens only pages of this app. A link names its company; when another one is active,
  the page offers to switch. On the iPhone push works only from the installed app.
- Stored: the devices (`spending_push_subscriptions`, migration 0029, additive).
- Off until the server holds `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`.

### Build order 4, budgets and warnings (2026-10-16)

- A monthly budget per category and, where the owner adds one, per counterparty
  (`src/lib/spending/budgets.ts`). Decided by the coordinator: a category's default limit is the
  owner's own average over the last twelve full months, computed from the payments (over the months
  the app has data for, not over twelve when it holds fewer); a number he sets replaces it, he can
  switch a budget off or go back to the average. Only the private part of a payment counts (a
  business counterparty not at all, the linked business part of a mixed one not).
  Stored: only his own numbers (`spending_budgets`, migration 0027, additive).
- A budget is "passed" when this month's spending is above it, and "on pace" when, from the seventh
  day of the month on, the projection to the month's end lies more than ten percent above it. The
  projection adds to what is spent so far what earlier months still spent after this day of the
  month, so rent booked on the first does not make the rest of the month look expensive (without
  history, the spending so far is carried forward evenly). The average counts only months with
  payments, and the first month of data only when it starts in its first three days.
- Each budget warns at most once per month, level and limit (a raised limit that is passed again
  warns again), at most five warnings per run, through the same notification port as the
  missing-receipt message; a warning that no longer holds leaves the in-app list. The loop and the
  budget warnings run independently, and the page says when either could not be checked.
- The warnings run together with the loop (`runSpendingChecks`): after every payment import and on
  "Jetzt prüfen". The budgets section on `/app/spending` shows each budget, where its limit comes
  from, and where the month is heading.


### Build order 3, the live bank connection (2026-10-16)

- Built in the finance area (finance plan, "Reality: the live bank connection (2026-10-16)"):
  per account, consent at the bank, "Jetzt abholen" and a daily machine run, off until the server
  holds its settings (`docs/operations/bank-sync.md`). Movements go into the same payments through
  the normal import, so the overview, the loop and the budgets read them like imported ones.
- After every fetch that added payments, `runSpendingChecks` runs for that company (from the
  button after the answer is sent, from the daily run once per company); a failure is logged only.
- The owner's decision: all five accounts tried live, each on its own, file importers as fallback.
  Publicly, Enable Banking lists Tomorrow, N26 and PayPal for Germany, Klarna as beta, and no
  Advanzia; the application's own list, read in the tab at run time, decides. An account already
  fed from the PayPal or Klarna list is not continued live (it would store purchases twice): such
  an account gets a new account of its own for the live connection.
