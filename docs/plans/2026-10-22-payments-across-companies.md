---
title: Payments across companies, each payment where its answer says
summary: An account stays connected once, in the company that holds it (Whiz-Art Media). The owner links it to his private company (marlinjai), and from then on every payment the holder's answers call private shows in marlinjai's spending overview, budgets and missing-receipt loop, while business and unanswered ones stay with the holder. The split is worked out on read, nothing is copied or moved, and an answer changed later moves the payment back at once.
type: plan
status: in-progress
tags: [finance, payments, spending, bank, privacy, workspaces]
projects: [receipt-ocr-app]
date: 2026-10-22
---

# Payments across companies

## The problem

A company here is a workspace, chosen with the switcher in the header. One person, the owner, is a
member of several. Payments come from accounts (`TaxAccount`, `TaxPayment`), and an account belongs
to exactly one company. All four of the owner's accounts (N26, Tomorrow, PayPal, Klarna; about 3,900
payments, private and business mixed) live in "Whiz-Art Media", his business. His private company
"marlinjai" has no account, so its spending overview, budgets and missing-receipt loop
(`src/lib/spending/`, page `/app/spending`) see nothing. That is the open question the personal
spending plan left (docs/plans/2026-10-14-personal-spending-and-bank-feed.md, Reality, build order
1: "payments are imported per company").

Private versus business is only a label inside Whiz-Art Media: a counterparty answer
(`TaxCounterpartyRule`: business, private, own_account, mixed), one payment re-labelled private
(`kind_override`), or a whole account said to be private (`is_private`).

## What the owner decided (option 1, 2026-10-22)

Each bank account stays connected once: one bank consent, one daily fetch, no second copy of the
bank data. Each payment lands in the company its answer says:

- answered private: it belongs to marlinjai (spending overview, budgets, private missing-receipt
  reminders, linking private receipts uploaded in marlinjai);
- answered business: it stays with Whiz-Art Media (tax, business receipts);
- not answered yet: it stays in Whiz-Art Media's question list until answered.

Answers already given apply at once, so the existing history splits too. The expenses mailbox
search serves both of the owner's companies.

## Words used here

- **Holder**: the company the account belongs to (Whiz-Art Media). Its payments tab is where the
  account is imported and connected and where every question about a payment is answered.
- **Receiver**: the company that gets the account's private payments (marlinjai).
- **Share**: the stored statement "the private payments of account A go to company R", one per
  account.
- **Routed**: a payment of a shared account that the holder's answers call private; it shows in
  the receiver and not in the holder's spending side.

## The model: worked out on read

Nothing is copied and nothing moves. One new table, `tax_account_shares` (migration
`0035_tax_account_shares`, additive), holds the share: the account, the holder (its workspace and
company stamp, like every row), the receiver's workspace and company, who created it and when.
Everything else is derived each time it is read:

1. `loadPayments(db, holder)` stays the one read of the payments area and of the tax figures. It
   is unchanged, except that it now reads only the links of the company reading (see "Links").
2. `loadRoutedPayments(db, company)` (`src/lib/tax/payments/routing.ts`) is the read of the spending
   side: the company's own payments less the ones routed away, plus the payments routed to it,
   with the receiver's own links on them.
3. Whether a payment is routed is one pure rule (`routesToReceiver` in
   `src/lib/tax/payments/route.ts`), built on the spending side's existing `purposeOf`: a payment
   of a shared account goes to the receiver when the holder has no link on it and, judged by the
   holder's answers alone, its purpose is private. There is no second private-or-business rule.

So a changed answer moves the payment at once, both ways, and nothing can go stale. Copying rows
was rejected: two copies of a movement drift apart, an import undone in one company would leave the
other's copy behind, and every changed answer would need a write in two companies.

## Decided, say so if you disagree

1. **One receiver per account.** A share names one company; the account can be shared again only
   after the share ended. The holder stays the holder: import, bank connection, undoing an import
   and every answer stay in its payments tab.
2. **The routing rule.** A payment of a shared account goes to the receiver when (a) the holder has
   no link on it to a receipt or an invoice and (b) the holder's answers make it private: its
   counterparty answered private, the payment re-labelled private, or (for a counterparty answered
   "Teils, teils" and on an account said to be private as a whole) nothing of it linked. Everything
   else stays with the holder: business, unanswered, own account, transfers, fees, income without a
   private answer.
3. **"Teils, teils" (mixed) and the private account.** An unlinked payment of a mixed counterparty
   or on an account said to be private is private (that is what the spending overview already says
   about it), so it goes to the receiver. Once the holder links it to a business receipt it is
   business and comes back to the holder whole. The owner named only private and business; this is
   the case he did not name, decided by what the overview already shows.
4. **A payment is in exactly one company at a time, whole.** A payment is never split across
   companies. A mixed payment partly linked to a business receipt stays with the holder, and its
   private rest is shown in the holder's overview as before.
5. **Answers are given in the holder only.** The receiver's own answers (a category for a
   counterparty, "own account" on its spending page) apply only in the receiver's view and never
   route a payment. The holder's category answers for the counterparties of routed payments apply
   in the receiver, below the receiver's own answer for the same counterparty (a category belongs to
   a counterparty, so it applies to all its payments there): the owner categorized private
   counterparties in Whiz-Art Media before the split, and that work is not lost. Data flows only from the holder to
   the receiver, and only for routed payments; nothing of the receiver flows back.
6. **Authorization.** A share is started in the holder's payments tab, by a person who is a member
   of both companies and holds the write permission (`receipts.row.write`) in both. Never by
   default, never by a member of only one side. A target outside the person's memberships is
   refused as forbidden, the same company and an account already shared are refused with a reason.
7. **Undo.** A writer of either company ends the share ("Weitergabe beenden"). The payments are then
   back with the holder at once, its spending side shows them again, and the receiver sees none of
   them. The receiver's links stay stored but dormant (see 9); sharing the same account with the
   same company again revives them.
8. **Links of private receipts.** The receiver links its own receipt to a routed payment from its
   spending page (confirming a proposed receipt, or taking an invoice over from the mailbox). The
   link belongs to the receiver (its workspace and company stamp), never to the holder.
9. **A link counts only while its payment routes to its company.** The holder never reads the
   receiver's links (`loadPayments` reads only the reader's links), so its tax figures, its loop and
   its private-or-business split cannot change through them. A payment answered back to business
   leaves the receiver at once; its link there is dormant (counted nowhere, shown nowhere) and
   lives again when the payment is answered private again. Links are not deleted on a changed
   answer: one answer touches dozens of payments, and deleting would make taking an answer back
   destructive. While dormant, the receipt still counts as linked in the receiver: it is not
   proposed for another payment, and it counts towards what the receipt is paid by.
9a. **A receipt is not paid twice.** A link of the receiver is refused with the same question as the
   holder's own ("receipt_already_paid") when the receipt's links, routed and own, would take it
   beyond its amount plus the tolerance for fees and rates; the holder's own link counts the
   receiver-held links of the same company too.
10. **Unlinking.** The receiver takes its link back on its spending page ("Beleg lösen" in the
    payment list). Deleting the private receipt takes its links along, as for any receipt.
11. **Undoing an import** in the holder takes its payments with every link on them, the receiver's
    included (the existing cascade). Answers and finds of the receiver about those payments stop
    applying, as answers of a vanished payment always did.
12. **Tax figures do not change in either company.** Private payments already count nowhere in
    Whiz-Art Media's tax figures; the holder's read is the same as before for every row that exists
    today (no receiver link exists before this change). The receiver's tax and review screens read
    only its own accounts, so a private receipt linked to a shared payment keeps its own day there.
    The holder's payments tab keeps listing every payment, the routed ones included, because that
    is where an answer is changed back.
13. **Spending overview and budgets.** The holder's overview and budgets leave routed payments
    out; its page names the accounts whose private payments go elsewhere. The receiver's overview
    shows routed payments as private, its budgets count them, and its account list names each
    shared account with the holder's name.
14. **Missing-receipt loop and notifications.** The holder's loop never asks about a routed payment,
    the receiver's does. A payment is notified about at most once across both companies: before
    sending, every company is checked for a notification of that payment by its subject, which
    names the payment id (only whether one exists, nothing of its content), so also a share that
    ended or went to another company cannot cause a second message. A payment that moved leaves the
    in-app queue of the company it left at once: after a share is started or ended (both companies)
    and after an answer, a link or an undone import in a holder that shares accounts (the holder and
    its receivers), each queue is settled after the answer is sent. The 14-day window stays, so
    splitting the history sends nothing.
15. **"No receipt exists"** said in the holder before the split still holds in the receiver. Said
    in the receiver, it is not read by the holder: a payment answered back to business needs a
    business document, and the holder asks again.
16. **The expenses mailbox** serves the company in `SPENDING_MAILBOX_WORKSPACE_ID` and every company
    that receives private payments of one of its accounts through a share. No new setting: the
    share is the owner's statement that those payments are his. Searches and finds are stored per
    company, so each company sees only the finds of its own payments.
17. **The live bank connection and the daily run** stay with the holder. After a fetch that added
    payments (the button, the daily run, a file import) the spending checks run for the holder and
    for every receiver of its shared accounts.
18. **Erasure of either company** ends its shares and removes the receiver's links on the holder's
    payments: an erased company keeps nothing tied to the other company's records. The payments
    themselves stay the holder's records.
19. **Moving a workspace to another company** (`src/lib/workspace-move.ts`) keeps the share (the
    workspace ids do not change); the holder's stamp moves with the generic restamp, the receiver's
    company stamp on the share is restamped by the same move.
20. **What the receiver sees of the account**: its label, the holder's name and up to which day it is
    read, nothing else (no other payment, no import, no connection).

## What each company sees and can write

| | Holder (Whiz-Art Media) | Receiver (marlinjai) |
|---|---|---|
| Payments tab | every payment of the account, the questions, the answers, import, bank, undo | the shared account named, with "Weitergabe beenden"; none of its payments |
| Tax and review | as before | as before (own accounts only) |
| Spending overview, budgets | own payments less the routed ones | own payments plus the routed ones, as private |
| Missing-receipt loop | own payments less the routed ones | routed payments (and its own) |
| Links | its own links only | its own links on routed payments only |
| Mailbox | as before | the same mailbox, finds of its own payments |
| Share | start, end | end |

## Data privacy

A company never sees another company's business or unanswered payments: the receiver's read is
built only from payments that pass `routesToReceiver`, and every write the receiver can make on a
payment (link, unlink, "no receipt exists", downloading or taking over a mail find) re-derives the
routing first (link and unlink inside their transaction, under the payment's row lock) and refuses a
payment that does not route to it, with the same answer as an unknown payment. "No receipt exists"
is checked just before it is stored; should the holder change the answer in that moment, the
receiver's answer is only stored, never shown or read by the holder. The holder never sees the receiver's receipts, links, answers or finds. Tests
prove each of these (`routing.dbtest.ts`).

## Tests: the four paths

- **Forward**: link the account; a private payment shows in the receiver and leaves the holder's
  spending side; a business and an unanswered one stay; the receiver links a private receipt; the
  loop notifies under the receiver only; the holder's tax figures are equal before and after.
- **Backtrack and revise**: a counterparty answer flipped from private to business moves the
  payment back to the holder at once, the receiver's link goes dormant and counts nowhere, the
  holder asks for a business receipt; flipped back to private, the payment and its link are back
  in the receiver with no write. Counter-case: answering the same private answer again changes
  nothing. A mixed payment linked by the holder returns to it.
- **Resume**: everything is derived from stored rows, so a fresh read (a new session, a restart)
  gives the same split; a payment notified in the holder before a flip is not notified again in
  the receiver.
- **Re-entry**: ending the share returns every payment to the holder; sharing again revives the
  links; undoing the import removes payments and links; erasure ends the share and removes the
  receiver's links.

## Reality

### Built (2026-10-23)

- **Table** `tax_account_shares`, migration `0035_tax_account_shares` (additive; the next free number
  on `origin/main` and every open branch and worktree on 2026-10-22).
- **The rule** `routesToReceiver` (`src/lib/tax/payments/route.ts`, pure) on top of the spending
  side's `purposeOf`, which learned one flag: a payment `routed` here is private.
- **The reads** (`src/lib/tax/payments/routing.ts`): `loadRoutedPayments` for the spending side,
  `routedPaymentFor` and `paymentOnSpendingSide` for every write a company makes on a payment there,
  `linkRoutedPayment` and `unlinkRoutedPayment` for the receiver's own links, `shareAccount`,
  `endShare`, `loadShares`, `receiversOf`, `receivesFrom`, and `endCompanyAccountShares` for erasure.
- **`loadPayments` reads only the reader's own links**, as do the automatic invoice links of an
  import, the free amount of a manual link and the count of released links. No link of another
  company existed before this change, so nothing that exists reads differently.
- **Spending side**: the overview, the budgets, the missing-receipt loop (states, notifications,
  "no receipt exists", confirming a proposed receipt, taking a mail find over) read
  `loadRoutedPayments`. The holder's category answers apply to routed payments below the
  receiver's own; the holder's "no receipt exists" answers too. A payment is announced at most once
  across both companies of a share.
- **Mailbox**: `mailboxFor` (`src/lib/spending/mailbox/server.ts`) answers the mailbox for its
  company and for every receiver of private payments of that company's accounts; the loop, the
  page's mailbox state and the attachment download go through it.
- **Checks after new payments** (`runSpendingChecksAfterNewPayments`): a file import, "Jetzt
  abholen" and the daily bank run check the holder and then each receiver. Sharing an account runs
  the receiver's checks once, after the answer.
- **Erasure** ends the company's shares and removes the links between the two companies' records;
  the erasure log line counts both. **Workspace move** restamps the receiver's company on a share.
- **Screens**: payments tab, section "Private Zahlungen in einer anderen Firma" (per account a
  company to choose and "Private Zahlungen weitergeben" with a confirmation; "Weitergabe beenden";
  in the receiver "Aus anderen Firmen" with the holder's name). Spending page: the shared account
  named with its holder, the holder's note where its accounts' private payments went, and "Lösen"
  on a routed payment with a private receipt.
- **Tests**: `routing.dbtest.ts` (20 tests through the four paths and the privacy promise, with the
  holder's tax statement compared before and after), `route.test.ts`, `sharing-actions.test.ts`,
  `AccountSharing.test.tsx`, and additions to the spending page, action, attachment and move tests.

### First review (2026-10-23), fixed

A fresh agent reviewed the diff: the privacy model held. Fixed: a payment could be announced a
second time after a share ended (now looked up by subject in every company, with an index on the
subject); messages about moved payments stayed in a queue until that company's next run (now
settled after sharing, ending, and every answer or link in a holder that shares); a receiver's link
was not held to the receipt's amount (now `receipt_already_paid` like the holder's); a mail find of
a payment that moved away could still be downloaded; the daily run could check a company twice;
the erasure count of links; wording.

### What the owner does after the deploy

In Whiz-Art Media, Finanzen, Zahlungen, section "Private Zahlungen in einer anderen Firma": for
each of the four accounts choose "marlinjai" and press "Private Zahlungen weitergeben". The
answers already given apply at once. Nothing else: no setting, no import, no second bank consent.
