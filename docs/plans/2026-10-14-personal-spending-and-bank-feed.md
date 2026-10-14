---
title: Personal spending, the live bank connection and the missing-receipt loop
summary: The owner decided on 2026-10-14 that private spending lives in the receipts app (company "marlinjai"), with an overview, a clean split for tax, budgets and warnings, a document for every purchase, and a live bank connection that finds or asks for the receipt of every payment. This plan records the decisions and the loop that does it.
type: plan
status: decided
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
5. **Otherwise ask.** A notification to the owner with the payment (vendor, amount, day) and a
   one-tap way to photograph or upload the receipt. The payment then sits in the open checks
   until a receipt is linked or the owner says "no receipt exists" (with the reason).

A payment that has been answered once is never asked again, and a vendor whose invoices always
arrive by mail is handled by step 3 without a notification.

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
- **Budget limits.** The numbers are the owner's.
- **The bank connection needs the owner's consent at each bank, repeated periodically.** Which
  accounts: the ledger holds four (Tomorrow, N26, Klarna, Advanzia) plus the payment service.
