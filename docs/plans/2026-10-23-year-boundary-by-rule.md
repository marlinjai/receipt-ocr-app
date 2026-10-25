---
title: The year-change list answers itself
summary: Payments between 22 December and 10 January no longer wait for a person. A year whose return is filed fixes them the way it was filed, and for open years a rule decides from the payment data (a subscription billed on its own period start stays in the year it was paid, an advance payment of value-added tax in early January belongs to the year before). Since 2026-10-25 there is no list to answer at all (decision 6): the rules decide, answers given before still apply, and what no rule settles stays in the year it was paid.
type: plan
status: in-progress
tags: [receipts, tax, year-boundary, payments]
projects: [receipt-ocr-app]
date: 2026-10-23
---

# The year-change list answers itself

## Why

The owner, 2026-10-23: the year-change list ("Jahreswechsel") "should be ruled out automatically,
as we have all payment bank accounts, Klarna and PayPal, so we know in which year what belongs,
also based on the tax reports that have been sent and filed already."

The list is the ten-day rule of section 11 of the income tax act (Einkommensteuergesetz):
a regularly recurring payment that falls due and is paid between 22 December and 10 January
counts for the year it belongs to, not the year it was paid in (`src/lib/tax/year-boundary.ts`).
Today nothing moves without a person's answer per payment. On 2026-10-23 production showed 17
open entries for Whiz-Art Media, all on the turn 2025 to 2026: Cursor, Google, Patreon, Akamai,
OpenAI, Anthropic, Apple and similar subscriptions, most of them on their receipt date because no
payment is linked.

Two facts settle most of it:

- **2025 is filed.** The owner stated on 2026-10-17 (plan 2026-10-11-pay-later-payments,
  decision 40) that the 2025 return was filed with every purchase on the day it was paid. 2021 to
  2024 are filed as well (plan 2026-10-11-import-tax-years-2021-2024). A payment on the turn of a
  filed year was declared in the year it was paid. Moving it now would make the app differ from
  the filed return, in either direction: a December 2025 payment moved to 2026 would leave 2025
  and count twice, a January 2026 payment moved to 2025 would be claimed in a return that is
  closed.
- **A subscription billed on its own period start belongs to the year of that day.** Cursor on
  26.12.2025 pays the month from 26.12.2025; OpenAI on 04.01.2026 pays the month from 04.01.2026.
  Neither is due for the other year, so the exception does not apply and they stay.

## Decisions (decided by the coordinating session on 2026-10-23, say so if you disagree)

1. **Filed years are recorded.** `TaxYearSettings` gets `filed_on` (a day, null for open). The
   income-tax tab shows "Erklärung {Jahr} abgegeben am …" with a control to set or clear it.
   The migration only adds the column; no company's facts go into schema history. After the
   deploy the coordinating session sets 2021 to 2025 as filed in Whiz-Art Media through that
   control on production, with the day the owner last confirmed it where the real day is not on
   record (2026-10-17 for 2025, 2026-10-11 for 2021 to 2024). The owner can correct each day in
   the tab.
2. **A filed year fixes its turn.** Every entry whose paid year or other year is filed gets the
   derived answer "bleibt im Zahlungsjahr", shown as "Festgelegt durch die abgegebene Erklärung
   {Jahr}". A stored answer saved before the filing day stays as it was (it was filed that way);
   a stored answer saved after it, that would move a payment across a filed year, is not applied
   and is shown with "Weicht von der abgegebenen Erklärung {Jahr} ab", so it is visible and can be
   taken back instead of silently changing a filed year.
3. **Rules for open years**, derived on read, overridable by a person's answer:
   - Value-added tax payments and refunds to or from the tax office: only where the company was
     regularly taxed on that day (`WorkspaceTaxSettings.smallBusiness` false and a
     `vatFrequency` set, so advance returns recur), one paid 1 to 10 January belongs to the year
     before (the advance return for December or the fourth quarter is due on 10 January), and one
     paid 22 to 31 December stays (it pays an earlier period of that year). Under section 19 of
     the value-added tax act (small business, Kleinunternehmer) there are no recurring advance
     payments: a payment to the tax office, such as reverse-charge tax under section 13b declared
     only for the period it arose in, is not regularly recurring and stays in the year it was
     paid. Reason shown: "Kleinunternehmer: keine regelmäßige Vorauszahlung". Narrowed on
     2026-10-23 after the owner pointed out that Whiz-Art Media is a small business.
   - A receipt of a counterparty that recurs (at least three months with a payment in the last
     twelve) stays in the year it was paid: it is billed at the start of the period it pays for.
     Reason shown: "Abo, Zeitraum beginnt am Zahltag".
   - A receipt that does not recur stays: the exception is only for regularly recurring payments.
     Reason shown: "einmalige Zahlung".
   - Only a recurring payment whose receipt names a service period lying wholly in the other year
     (rent for January paid on 28 December) moves; the reading of a service period is used only
     where the receipt already carries one. Anything else no rule settles stays in the list as an
     open question.
4. **Nothing is written by the rules.** The answer is worked out on every read, like the shares
   between companies (migration 0035). `TaxYearBoundaryAnswer` keeps meaning "a person said so"
   and overrides. Changing a filed day, linking a payment or answering a counterparty recomputes
   the list at once.
5. **The tab shows the reason for every entry** and counts as open only what has neither a
   person's answer nor a rule. The "Jahreswechsel" tab count in the finance page shows that open
   number, expected to be zero for 2025/2026.
6. **No year-change list at all** (the owner, 2026-10-25: "the tab in the UI can go, it only
   confuses people"; supersedes decision 5 and the person's override of decision 3). The rules
   above decide by themselves; the "Jahreswechsel" tab, its answer buttons and the server actions
   behind them are removed. Answers a person gave before still apply as stored (the read is
   unchanged); nothing creates new ones. A payment no rule decides (a receipt without a vendor, a
   settlement while the small-business question or the advance return period is unanswered)
   stays in the year it was paid, the cash-basis default. Where the rule moved something, the
   statement still says so on the item ("zählt für {Jahr} (Jahreswechsel)"). The filing-day
   control in the income-tax tab stays: decision 2 needs it.

## Implementation notes (decided while building, 2026-10-23, say so if you disagree)

Notes about refusing, showing or taking back answers describe pull request 174; since decision 6
(pull request "no year-change tab") nothing writes answers and nothing shows them, so those parts
are superseded. The read rules below still hold.

- **"Saved after the filing day"** compares the day (Europe/Berlin) a person's answer was last
  saved (`updatedAt`) with `filed_on`. An answer saved on the filing day itself counts as filed with
  the return: on that day the two cannot be told apart, and changing a filed year is the worse mistake.
- **Both years filed:** the reason names the paid year; a departing answer names the return it was
  saved after.
- **A move across a filed year is refused when saved** (`year_boundary_filed`), so a departing answer
  can only arise when the filing day is recorded or moved after the answer was given. Such an answer is
  shown and can be taken back; an answer given before the filing day is part of the return and is shown
  without buttons (to change it, clear the filing day first). "Stays" on a filed year is accepted.
- **Recurring** means at least three distinct months with a receipt of the same vendor (by its payment
  day, else its receipt day) or a payment out naming it, among the twelve calendar months before the
  payment's month. The payment's own month does not count.
- **Service period:** receipts carry none yet, so the one moving rule for receipts is absent and every
  receipt of an open year with a vendor stays by rule. Only a receipt without a vendor stays open.
- **Value-added tax settlements** are judged by the small-business status of the period they can
  pay (status changes included): for a January payment the status on 31 December of the year before
  (it pays the December or fourth-quarter return), for a December payment the status on its day; and
  by whether an advance return period is chosen. While either answer
  is missing no rule decides, so the settlement stays in the year it was paid instead of being guessed.
  The return period is the company's current setting (it is not kept per day).
- **An answer that went into a filed return** (saved up to the filing day, for the payment day
  that still applies) is refused when changed or taken back; one given after the filing day can be
  taken back. Saving the answer that is already stored is a no-op and keeps its day.
- **Both years filed, answer saved between the two filing days:** the payment was declared in
  neither return (the earlier one was filed before the answer, the later one with it). The answer
  is reported as departing from the earlier return and the payment counts in the year it was paid,
  the cash-basis default, instead of moving money into a closed year.
- **The filing day** must be a real day, not in the future and not before the year ended.
- Meals and assets keep their behaviour: no rule or filed year applies to them, and an earlier
  person's answer has no effect on them.

## Tests (four paths, standard `stateful-flow-testing.md`)

- Forward: the 17 kinds of entries resolve to their rule; the filed year locks its turn; the
  statement totals of a filed year do not change.
- Backtrack and revise: clearing a filed day unlocks the turn and the open-year rules apply;
  an earlier answer overrides a rule and without it the rule returns; a counterparty that
  stops recurring changes its reason.
- Resume: reload shows the same derived answers (nothing stored but the filed day).
- Re-entry: setting the same filed day twice is a no-op; a stored answer after the filing day is
  reported, never applied.

## Build order

1. Migration (`filed_on`), the filed-day control in the income-tax tab.
2. Derived answers in `loadStatement` (`src/lib/tax/service.ts`) and the reasons in
   `YearBoundaryTab`. Wait for the PayPal live pull request (branch `feat/paypal-live`, which also
   changes `src/lib/tax/service.ts`) to merge, then rebase before opening the pull request; take
   the next free migration number at that point.
3. Fresh-agent review, pull request, land-pr (done: pull request 174).
4. Remove the year-change tab (decision 6), then record 2021 to 2025 as filed for Whiz-Art Media on
   production through the income-tax tab and check on a moved and an unmoved 2025/2026 payment that
   the statement shows them in the year they were filed.
