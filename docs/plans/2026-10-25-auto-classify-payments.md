---
title: The app classifies payments by itself
summary: Every counterparty of the payments gets private, business, own account or mixed, and a spending category, without the owner answering it. Clear cases are decided from the company's own data and, for the rest, by a language model, and applied directly, marked as made by the app and changeable in one click. Only what stays uncertain is asked, largest sums first. Transfers to the owner's own name count as own account under Finanzen too.
type: plan
status: decided
tags: [receipts, payments, spending, classification, ai]
projects: [receipt-ocr-app]
date: 2026-10-25
---

# The app classifies payments by itself

## Why

The owner, 2026-10-25, looking at Finanzen and Ausgaben: he cannot see at a glance what was
private and what went into which category, and asked why he has to analyse and assign the
payments himself at all. On 2026-10-23 production showed 82,115 of 83,486 EUR of 2026 spending
"nicht zugeordnet" for Whiz-Art Media: nobody had said private or business per counterparty.

Today a language model reads every receipt (`src/lib/receipt-classifier.ts`), but the payments
only have fixed rules (own transfers, funding of pay-later services, keyword categories in
`src/lib/spending/rules.ts`). "Private or business" per counterparty waits for a person in the
payments tab, one counterparty after the other.

His decision, same day: "Ich würde das direkt anwenden, sichtbar machen und jederzeit änderbar
haben. Also ja, die App soll ... das dann direkt anwenden, go ahead." Business and private money
are not cleanly separated on his accounts until 1 January 2027, which is exactly why the
answer per counterparty matters.

## Decisions

1. **Applied directly, visible, changeable** (the owner). A verdict the app is certain of counts
   at once, everywhere a person's answer counts today: the payments tab, the statement, the
   spending overview, the routing of private payments to the receiving company. It is shown as
   "von der App eingeordnet" with its reason, and one click replaces it with a person's answer,
   which then wins for good.
2. **Who decides, first hit wins, one function used everywhere** (taken by this session):
   1. a person's answer (`TaxCounterpartyRule`, `SpendingCategoryAnswer`), unchanged;
   2. the owner's own names (decision 5);
   3. the app's verdict when it is certain;
   4. for the category only: the existing keyword rules, then the app's verdict when certain;
   5. otherwise open, as today.

   The merge happens once, in `loadPayments` (`src/lib/tax/payments/service.ts`), which every
   read of the payments goes through (tax figures, payments tab, routing, spending). A parallel
   map says where each treatment comes from (`person`, `own_name`, `app`), so the screens can
   label it.
3. **What the app decides, and how.**
   - **From the company's own data first, no model:** a counterparty whose payments are linked to
     receipts that are all business is business; all linked receipts private means private.
   - **The model for the rest:** one call per batch of up to 20 counterparties. Sent per
     counterparty: its name, how many payments and the sums in and out, up to three payment
     texts, whether the account is marked private, and the categories of receipts linked to it.
     Account and card numbers and other long digit runs are masked out of the texts. The company's
     name is known only in a signed-in session, not in the daily run, so the prompt describes the
     situation the same way every time (a sole proprietor in Germany whose money runs over shared
     accounts until 2027) instead. It answers per
     counterparty: treatment, category (one of the twelve), confidence (`certain`, `likely`,
     `unsure`) and a short German reason.
   - **Web search** (as the receipt reader does) only for a name that looks like a business (a
     legal form, a domain, a number of two digits or more), never for what looks like a private
     person's name: those are asked in a separate call that has no search tool at all.
   - **What the model may not decide alone:** an own account (own names and the funding rule
     decide that, and it takes the money out of every figure), and anything but business for a
     counterparty that paid money in (a client's payment would stop asking for its invoice). Such
     a verdict is kept as a proposal.
   - **Payments of an account said to be private as a whole** are not sent at all, and a business
     verdict of the app never lifts the private account: only a person's answer does.
   - **Only `certain` is applied.** `likely` and `unsure` are stored too, so the model is not
     asked again on every run, and shown as a proposal with one-click confirm in the open list.
   - The verdict is stored with a fingerprint of its evidence (the linked receipts). It is
     asked again only when that evidence changes, never on every run. A counterparty the model
     answered nothing usable for is stored as unsure, so it is not paid for again; a verdict the
     receipts made is removed as soon as they disagree, also when no model can be asked.
   - The model's output is checked strictly (known values only); long dashes in the reason are
     replaced, the reason is cut to 200 characters.
4. **Stored as the app's, never as a person's.** New table `tax_counterparty_verdicts`
   (migration 0039): counterparty key, label, treatment, category, confidence, reason, source
   (`evidence` or `model`), model id, fingerprint, timestamps. `TaxCounterpartyRule` and
   `SpendingCategoryAnswer` keep meaning "a person said so"; a person's answer is never written
   by the app.
5. **Own names count under Finanzen too.** Transfers to a counterparty carrying one of the
   owner's own names (`SpendingSettings.ownNames`, plan 2026-10-23-budget-overview decision 1)
   are own account in the payments tab and the figures as well, unless a person answered that
   counterparty. This reverses the limit in `src/lib/spending/own-names.ts` ("about spending
   only"): for the income-surplus statement it makes no difference whether money from a mixed
   account to the owner is a private withdrawal or an own transfer, neither is an expense, so the
   question asked nothing useful. Recorded in the budget-overview plan as well. This holds for every
   company in the app: it computes only the income-surplus statement, which a corporation (a UG,
   a GmbH) does not file, so money to the owner of a corporation never runs through these
   figures.
6. **When it runs.** As a third step of `runSpendingChecks` (`src/lib/spending/checks.ts`),
   before the missing-receipt loop so the loop sees the new verdicts, on its own try/catch like
   the other two steps: after a file import, "Jetzt abholen" and the daily bank run. A run
   classifies at most 100 counterparties, largest sums first, so the history is worked down over
   a few runs and the daily run stays inside its time limit. A run stops starting new model calls
   after two minutes; a page waiting for the checks ("Jetzt prüfen") lets the model decide at most
   one batch. Deciding from the company's own receipts, and removing such a verdict when they
   disagree, runs over every undecided counterparty, as it costs nothing. The payments tab gets "Jetzt
   einordnen", which runs one batch and returns the view. Without a model key the step says so
   (logged and shown on the tab), it never pretends to have classified.
7. **Consequences, intended.**
   - A counterparty the app calls private moves its payments of a shared account to the
     receiving company (plan 2026-10-22, payments across companies), exactly as a person's
     answer does. The receiving company categorises them on its own run.
   - A counterparty the app calls business asks for receipts where they are missing: the open
     list grows, notifications stay limited to payments of the last 14 days
     (`NOTIFY_WITHIN_DAYS`), so history sends no messages.
8. **Cost.** A few hundred counterparties per company, 20 per call, `claude-opus-5-5` at low
   effort (configurable with `ANTHROPIC_COUNTERPARTY_MODEL`; the house default for new model code,
   a second, escalating model was left out as it saves cents and adds a failure path): about four
   cents per batch, well under one euro for the backfill of a company, then a few calls a week.
   Each batch logs its token counts, never a name.

## Build order

1. Migration 0039 and the read side: the precedence (decision 2) and own names in `loadPayments`,
   the source map, unit tests of the pure precedence.
2. The classifier port (`CounterpartyClassifierPort`, a fake in tests), the Anthropic adapter
   following `receipt-classifier.ts` (direct with web search, OpenRouter fallback, a missing key
   reported), the evidence step without a model, the stored verdicts.
3. The check step and "Jetzt einordnen".
4. The screens: the payments tab shows the app's verdicts with reason and a change control, the
   proposals with confirm, and only the rest as open questions; the spending overview's
   unassigned share shrinks by itself.
5. Fresh-agent review, pull request. After the deploy, run the backfill on production and check
   in the browser what the app classified, applied and left open; report the counts.

## Tests (four paths, standard `stateful-flow-testing.md`)

- Forward: evidence verdicts need no model call; a certain model verdict counts in the payments
  tab, the totals and the spending overview; likely and unsure ones only propose.
- Backtrack and revise: a person's answer overrides a verdict, taking it back returns the
  verdict; a new receipt link changes the fingerprint and causes exactly one new verdict; an own
  name added or removed changes the treatment at once.
- Resume: a reload shows the same effective answers, nothing stored but the verdicts.
- Re-entry: a second run asks the model about nothing already decided (the fake port's call
  count); a model failure leaves the counterparty open and the loop still runs; another
  company's verdict never applies here.
