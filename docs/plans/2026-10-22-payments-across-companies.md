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
   "Teils, teils" and on an account said to be private as a whole) nothing of it linked. That holds
   whatever the payment is (a purchase, money back, income such as a friend paying back, a fee),
   except a transfer between own accounts (an own-account answer, the funding rule, a person's
   word): it stays where the accounts are. Everything else stays with the holder: business,
   unanswered, own account, transfers.
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
   Accepted: membership and permissions are checked when the share starts. Should the person later
   lose either, the share stays until a writer of either company ends it; the server cannot see
   other people's memberships to end it by itself.
7. **Undo.** A writer of either company ends the share ("Weitergabe beenden"). The payments are then
   back with the holder at once, its spending side shows them again, and the receiver sees none of
   them. The receiver's links stay stored but dormant (see 9); sharing the same account with the
   same company again revives them.
8. **Links of private receipts.** The receiver links its own receipt to a routed payment from its
   spending page: confirming a proposed receipt, taking an invoice over from the mailbox, or picking
   one of its receipts by hand when no proposal fits ("Vorhandenen Beleg zuordnen" on every open
   check, in every company: asked from the server when opened, the 30 receipts this payment can go
   on that lie closest in amount and day, partly paid ones included, and a search by name, vendor or
   amount for the others). What is offered is what can be linked: the same paid-by sum
   (`paidByReceipt`, a purchase and its funding debit once) and the same tolerance as the guards. The
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
10. **Unlinking.** The receiver takes its link back on its spending page ("Lösen" in the payment
    list). A dormant link is listed there too ("Belege an Zahlungen, die nicht mehr hierher gehören",
    with the day it was linked and its amount, nothing of the payment) and can be taken back, so a
    receipt is never stuck. Deleting the private receipt takes its links along, as for any receipt.
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
    and after an answer, a link, an undone import or a deleted receipt in a holder that shares
    accounts (the holder and its receivers; also the own-account answer on the spending page, and a
    receipt deleted on the dashboard or the meals page), each queue is settled after
    the answer is sent. The 14-day window stays, so splitting the history sends nothing. One
    exception, accepted: erasing a company removes its messages about the other company's payments
    (they name that company's counterparty and amount), and with them the record that such a
    payment was announced; a payment of the last 14 days that is back with the holder can then be
    announced there once more.
15. **"No receipt exists"** said in the holder before the split still holds in the receiver, shown
    as answered there ("beantwortet in der Firma, die das Konto führt") and taken back only in the
    holder, where it stays listed with the note that the payment now stands in the other company;
    the receiver's own answer stands above it. Said in the receiver, it is not read by the
    holder: a payment answered back to business needs a business document, and the holder asks
    again.
16. **The expenses mailbox** serves the company in `SPENDING_MAILBOX_WORKSPACE_ID` and every company
    that receives private payments of one of its accounts through a share. No new setting: the
    share is the owner's statement that those payments are his. Searches and finds are stored per
    company, so each company sees only the finds of its own payments.
17. **The live bank connection and the daily run** stay with the holder. After a fetch that added
    payments (the button, the daily run, a file import) the spending checks run for the holder and
    for every receiver of its shared accounts.
18. **Erasure of either company** ends its shares and removes the receiver's links on the holder's
    payments, and what one company keeps about the other's payments ("no receipt" answers, mailbox
    searches and finds, messages): an erased company keeps nothing tied to the other company's
    records. The payments
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
payment (link, "no receipt exists", downloading or taking over a mail find) re-derives the routing
first (a link inside its transaction, under the payment's row lock) and refuses a payment that does
not route to it, with the same answer as an unknown payment. Unlinking touches only the company's
own links, dormant ones too, and reads nothing of the payment: without a link of the company it
answers "no link" whether the payment exists or not. A row lock is taken only on a payment of an
account shared with the company (a link) or one carrying a link of the company (an unlink). "No receipt exists"
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

- **Table** `tax_account_shares`, migration `0035_tax_account_shares` (additive: the table and two
  indexes, on `spending_notifications.subject_key` and `tax_payment_links.auth_workspace_id`; the
  next free number on `origin/main` and every open branch and worktree on 2026-10-22).
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
- **Tests**: `routing.dbtest.ts` (35 tests through the four paths and the privacy promise, with the
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

### Second review (2026-10-23), fixed

The privacy model held again. Fixed: a receipt linked on a shared payment is linked for the
company's own proposals and its accept-all too (`loadPayments` carries `linkedElsewhere`, one
source for the proposals, the guards and the loop); an inherited "no receipt" answer is marked and
refused with its own message instead of a take-back that did nothing; dormant links are listed and
can be taken back; erasure removes the answers, finds and messages kept about the other company's
payments; settling after a change runs only where a shared account is touched, and a burst of
answers settles once more at the end instead of once per click; a transfer between own accounts
never routes (the rule and Decided 2 now say exactly what moves); the guards leave cancelled
purchases out and count a purchase and its funding debit once; one message per payment is atomic
across companies (a lock on the subject); an account removed between check and write is
`account_not_found`. Tests for each, and for the finance actions' settling and the erasure route.

### Third review (2026-10-23), fixed

No blocker; fixed: the own-account answer on the spending page settles the queues too; the
holder keeps its own "no receipt" answers about payments routed away listed, so they can be taken
back where they were given; the move's dry run counts the receiving company's stamp on shares; an
index on `tax_payment_links.auth_workspace_id` (every read of a company's payments filters on it);
the receiver's link has no unused confirmation path; comments and this plan say exactly what
unlinking checks; the erasure exception above is written down.

### Fourth review (2026-10-23), fixed

No blocker; fixed: tests for the lock on the subject (three announcements at once store one
message), for `touchesSharedAccount` against the database (payment, account, counterparty by name
and by key, unshared accounts) and for the coalescing of settling runs; "Lösen" answers "no link"
when nothing of the company's is left on a payment, so a second press is not mistaken for a moved
payment; row locks are taken only on payments of an account shared with the company or carrying
its link; the check whether a payment
is on a company's spending side reads a share exactly as the spending read does.

### Fifth review (2026-10-23), fixed

No blocker; fixed: a receipt deleted on the dashboard or the meals page settles the queues too
(one shared helper, `settleMovedPaymentsLater`, for every place); the dormant-link note names a
cancelled payment as well; a payment that moved away shows its own message in the open checks;
the accessible names of the sharing buttons start with their visible text; the sharing section
takes over fresh server data; the holder's erasure is tested for every kind of kept record, mail
finds included; the lock sentence above and the accepted points in Decided 6 and below.

Accepted cost: linking a private receipt reads the holder's payments in full two or three times
(about 3,900 rows each), once inside the transaction. A narrower query would need a second copy of
the private-or-business rule; for one owner's accounts the reads are fast enough.

### Sixth review (2026-10-23), fixed

No blocker; fixed: a receipt can be linked by hand to an open payment from the open checks (the
receiver had no way to link a private receipt whose wording or amount does not fit a proposal);
the sharing texts name the "Teils, teils" payments and what stays; the payments tab says so when
the sharing section cannot be read; the holder's note on its spending page names what stays; the
"Lösen" buttons' accessible names start with their visible text; one wording for a payment that is
gone, whether its import was undone or it moved; inherited categories per holder and the latest
answer first, so the result never depends on row order; the comment on money back.

Accepted: money back that is routed to the receiver stays without a link (the loop asks for no
receipt for it; linking it in the holder would make it business and take it back there).

### Seventh review (2026-10-23), fixed

No blocker; fixed: a hand choice for a payment that got its receipt in the meantime is refused
with its own message instead of an answer that looked like success; the hand choice offers the 30
closest receipts per payment (amount still open, then day), partly paid receipts included, with a
search for the rest, drawn only for the payment a person opens it on; the refusals of a hand
choice have their own words; the list names the vendor and marks estimated amounts; the hand
choice is tested back and forth (taken back, offered again, linked to another payment, refused for
a payment answered meanwhile).

### Eighth review (2026-10-23), fixed

No blocker; fixed: one paid-by sum per receipt for the guards and the hand choice
(`paidByReceipt`: a purchase and the debit funding it once, money back taken off, never below
nothing), so the amount still open is right; a receipt is offered only where the guard would let it
be linked; the choices are asked from the server when the picker opens, not sent with every view;
the picker takes the focus, can be closed with "Abbrechen" (focus back to its opener), announces
its results in one live region, asks again after a fresh view, and says "gefunden" only for a
search; a link made from the open checks is announced at the page and the focus goes to the list
heading; tests for the search's privacy, a hand choice on the holder's own payment with its guard,
and `paidByReceipt`.

### Ninth review (2026-10-23), fixed

No blocker; fixed: the company's own link guard reads `paidByReceipt` too, so all three (the
holder's link, the receiver's link, the picker) agree on what pays a receipt; the picker drops an
answer that a newer request overtook, asks again after a fresh view or when reopened, and allows a
new search while one runs; the two "Abbrechen" buttons of an open check have names of their own;
a single receipt is announced without the ranking phrase; a page notice belongs only to the action
that set it; the tolerance is read from its one home, and the paid-by sum is built only where the
hand choice needs it; tests for the tolerance filter, own money back with a link elsewhere, and a
slow answer.

### Tenth review (2026-10-23), fixed

No blocker; the holder's own link guard was checked to behave exactly as before for a company that
shares nothing. Fixed: the open checks and the payment list of the spending page take over each
other's changes (every successful action reads the page afresh, and both take the fresh data over);
the picker empties its search field whenever it asks afresh unfiltered.

Accepted: the picker hides a receipt whose only link sits on the bank debit funding the purchase
(the payments tab's own move of that link stays the way to do it); the receiver never meets this,
because a routed payment has no funding twin.

### Eleventh review (2026-10-23), fixed

No blocker; fixed: the summary of "Jetzt prüfen" stays when the page reads the checks afresh; an
open list for linking by hand keeps what was typed and chosen across a fresh view, keeps the list
on screen while it asks once more with the last search, and lets go of a choice only when it is no
longer offered; marking a notification read and saving the notification settings read nothing else
afresh; errors that asked for a reload go when fresh data arrives; the per-row notice that nothing
ever set is gone.

Accepted: should the page's own read fail during that fresh read, the page shows its existing
error card with "Neu laden", as it does on any load; the action itself succeeded and is kept.

### Twelfth review (2026-10-23), fixed

No blocker; fixed: a mail taken over whose link failed keeps its message (no fresh read after a
link that was not made); an error stays while its payment is still open and goes only with a
payment that left the list; the checks panel is keyed by company, so after a switch nothing of the
other company stays (a summary, a notice, the settings form); an open list asks again quietly after
a fresh read, without announcing an unchanged list. The summary of "Jetzt prüfen" ends with the
next action of the panel, as a notice belongs to the action that set it (said in the code).

### Thirteenth review (2026-10-23), fixed

No blocker; fixed: a mail whose link failed says so at the page when its payment left the list; a
mail taken over for a payment that got another receipt in the meantime is refused with its own
message instead of a success with the new receipt unlinked (the same receipt again stays a no-op);
an error about an answer or a notification goes with its row too; one count of answered payments
in both places; dormant links are one entry per payment, as "Lösen" takes all of them back; tests
for the failed mail link, the quiet re-ask and the mail refusal.

### What the owner does after the deploy

In Whiz-Art Media, Finanzen, Zahlungen, section "Private Zahlungen in einer anderen Firma": for
each of the four accounts choose "marlinjai" and press "Private Zahlungen weitergeben". The
answers already given apply at once. Nothing else: no setting, no import, no second bank consent.
