---
title: Assignment decided by a model that learns the person
summary: Who bears a receipt's cost (Geschäftlich, Universität, Privat) is decided by a model that knows the person: facts they state, how they answered each vendor before, and the corrections they made. A confident answer is set automatically and marked as such, an unsure one stays asked with the model's suggestion. The context grows from every answer, so a new user starts with document evidence only and the app learns them over time. Measured on every receipt that already has a person's answer before it is switched on.
type: plan
status: in-progress
tags: [receipts, classification, assignment, models]
projects: [receipt-ocr-app]
date: 2026-11-07
---

# Assignment decided by a model that learns the person

## Why

Since #75 (2026-10-11) the reader never answers "Privat" on its own: a model that knew nothing about
the person had filed 65 of 221 business software invoices as private in one import, and a wrong
"Privat" silently leaves a receipt out of the books. Since then every receipt without a matching rule
asks "Zuordnung fehlt" in "Belege prüfen", including receipts whose answer is obvious to anyone who
knows the person: a Rossmann receipt for chocolate on 2026-11-06, although the person had answered dm,
Denn's and REWE as private before. The owner, 2026-11-07: a decision model that knows enough about the
person would decide these correctly; confident answers are set automatically; and for other users of
the app the context has to be built over time, learned from the user.

## Decisions (taken with the owner on 2026-11-07)

1. **A separate assignment decision after the reading.** The reader keeps answering only from document
   evidence (#75 stays). A second step, `decideAssignment`, gets the receipt (vendor, date, category,
   line items, the item name, the recognized text), the person's context (decision 2) and answers one
   of the workspace's assignment options or null, with a confidence from 0 to 1 and one sentence of
   reason. Model: the upload model by default, configurable (`AI_ASSIGNMENT_MODEL` /
   `ANTHROPIC_ASSIGNMENT_MODEL`); the replay (decision 6) may pick a stronger one if the cheap one does
   not reach the bar.
2. **The context is learned, per workspace, from three sources, none of them a fixed list in code:**
   - **What the person states.** The existing `freetext` rules ("an instruction for the chat
     assistant") become the person's statements about themselves and are given to the assignment
     model too. They are written on the Regeln page or by the chat assistant when the person says
     something about their situation. Dated facts are allowed ("since May 2026 no university").
   - **How the person answered before**, computed live from the receipts table: per vendor, the
     assignments a person set (not the automatic ones) with counts and the latest dates, plus a
     handful of the person's most similar earlier receipts (same vendor or same category) with their
     line items and answer. Never stored as a second copy.
   - **Corrections.** When a person changes an automatically set assignment, that is recorded with
     the receipt and given to the model as an example of its own mistake. This is the strongest
     signal and how the app learns a new user fastest.
   A new workspace starts with none of it: the model then answers only from document evidence, like
   the reader today, and gets better with every answer.
3. **Vendor rules stay as hard overrides.** A matching `vendor` or `keyword` rule wins without asking
   the model, as today.
4. **Confident answers are set automatically; unsure ones are asked with the suggestion.** Above the
   threshold (decision 6) the assignment is set and the receipt shows "Automatisch zugeordnet: <reason>"
   with one click to change it; below, "Belege prüfen" asks as today, with the model's suggestion
   marked on its button and the reason shown. A failure of the model never sets anything and is
   logged. Every decision is recorded (assignment, confidence, reason, model, the facts it rested on)
   and keyed to its inputs: a person's later answer always wins and is never overwritten.
5. **Owner's facts, seeded as freetext rules of Whiz-Art Media** (they are his statements, the
   mechanism is the same for everyone):
   - Software, cloud, gear and business travel are business.
   - Studies ended around April/May 2026: no university expenses after that date unless a new
     master or PhD starts.
   - Drugstore, groceries and streaming for himself are private.
   - Amazon, Apple and MediaMarkt are mixed: decide by what was bought, never by the vendor.
   - Restaurants are private unless the meal is marked as a business meal (Bewirtung with occasion).
     The automatic assignment never takes a receipt out of the Bewirtung list, and marking a meal as
     a business meal sets the assignment to business.
6. **Measured before it is switched on.** A replay over every receipt whose assignment a person set,
   per workspace, in date order: the model sees only the context that existed before that receipt
   (earlier answers, the statements), never the receipt's own answer. Reported: accuracy per option,
   and how often it would have set "Privat" on a business receipt and "Geschäftlich" on a private one.
   The threshold is chosen so both wrong-way rates are below 1 in 100 among the receipts it would set
   automatically; if no threshold reaches that, the feature ships as suggestion only and the plan
   says so.
7. **After release, the open receipts are decided once** (the unassigned ones of every workspace),
   through the same path, so confident ones are set and marked and the rest stay asked.
8. **"Was ist das?", and "Teils, teils" decided per payment (added by the owner on 2026-11-08).** The
   payments page "Wer ist das? Was die App nicht sicher einordnen konnte" asked only business or private,
   never what a counterparty is. The owner: "Flaschenpost ist zum Beispiel Wasser"; "eBay kommt voll drauf
   an, da müsste man wirklich nach den Belegen schauen."
   - Each counterparty card and each receipt assignment card gets an optional short answer "Was ist das?"
     (free text, e.g. "Getränkelieferdienst, Wasser"). It is stored as one of the person's statements
     (decision 2), keyed to the vendor or counterparty, and given to both the receipt assignment model and
     the counterparty classifier that writes the "Vorschlag der App". The classifier also says what it
     takes the counterparty to be, so the person corrects the "what" as well as the "who".
   - For "Teils, teils" counterparties (eBay, Amazon, Apple, MediaMarkt) the decision is per payment, from
     the linked receipt's line items, by the learned assignment model (decision 1). A mixed payment without
     a receipt stays a question with "Beleg wählen". Where line items are missing, the reason says so.
   - Set by hand on production on 2026-11-08 and left as they are: flaschenpost SE private, eBay S.a.r.l.
     mixed.

## Decisions taken while building (by the implementing session, 2026-11-07 and 2026-11-08, say so if you disagree)

9. **The model is Sonnet 5.5, not the upload model** (`AI_ASSIGNMENT_MODEL`, default
   `anthropic/claude-sonnet-5.5` on OpenRouter; `ANTHROPIC_ASSIGNMENT_MODEL`, default `claude-sonnet-5-5`
   on the direct path). Decision 1 allowed the replay to pick a stronger one: Haiku 5.5 reached the bar
   only at a confidence of 0.95 and would have set 45 percent of the receipts automatically, Sonnet 5.5
   reaches it at 0.9 with 69 percent (see "Measured"). The price is about 0.6 cents per decision against
   0.04 for Haiku; a person's receipts are few, the mistakes are what costs.
10. **The threshold is 0.9** (`AUTO_ASSIGN_CONFIDENCE` in `src/lib/assignment/pass.ts`). With Sonnet 5.5 the
   lowest threshold at which both wrong-way rates stay below 1 in 100 is 0.75, but only by a hair (9 of 909,
   0.99 percent): one more mistake fails it. At 0.9 both are well under (2 and 3 of 725), and all other
   mistakes drop from 47 to 11. Decision 6 asks for "below 1 in 100", not for the lowest threshold.
11. **A freetext rule may name no assignment.** Two of the five statements of decision 5 ("studies ended",
   "Amazon, Apple and MediaMarkt are mixed") name no single option, and the rules required one. The column
   `classification_rules.zuordnung` takes null, for freetext only (migration 0051); a vendor or keyword
   rule still needs one. On the rules page the kind is now called "Aussage über mich" and offers "keine
   bestimmte". The chat assistant can save a statement too (`remember_statement`, approved by the person
   like every change it proposes).
12. **The reader's own answer counts as automatic.** Since #75 the reader still sets "Geschäftlich" or
   "Universität" where the document itself shows it (a company addressee, a VAT number, reverse charge).
   Without a record, the pass would take such a cell for the person's answer and learn from it. The upload,
   the retake and "Seite neu lesen" now record it as an automatic decision with the reason "Auf dem Beleg
   selbst zu sehen ..."; a person's change of it is a correction like any other.
13. **Who said what is derived, not flagged.** A cell holds an automatic answer exactly while a decision
   with outcome "set" exists for it, no person's answer is recorded and the cell still holds that value.
   Everything else is a person's answer, whichever path wrote it (table edit, "Set field", a review card,
   the chat, a meal marked as business meal, a finance decision). The pass also finds such answers itself,
   so no write path can slip past it; the table edit and "Set field" record them at once. A person who
   empties an automatic answer has answered too: the receipt is asked and never decided again.
14. **What the pass does not decide.** A meal (the meal register judges it, and an automatic "Privat"
   would take it out of the Bewirtung list), a receipt a finance decision or a finance vendor rule settles
   (the finance area writes its cells), and a receipt a reading rule matches (decision 3; an automatic
   answer a new rule contradicts gives way to the rule). Their answers are still the person's evidence for
   other receipts, except the ones a reading rule set.
15. **A business meal sets "Geschäftlich" when it is saved as "Geschäftsessen (extern)" with an occasion**,
   whatever the cell held; that is the person's newest word on that receipt.
16. **Where it runs.** After an upload, a retake, "Seite neu lesen" and an edit of the vendor, category or
   item (bounded to 3 model calls), from the tools page ("Zuordnungen entscheiden", 20 per request, the
   page asks again until none is left), and daily for the receipts whose decision failed (the resume path).
   The daily run deliberately does not take every open receipt: that is decision 7's one pass, which waits
   for the owner's go.
17. **Kept with the receipt, gone with it.** The decisions live in `receipt_assignment_decisions` (one row
   per receipt, keyed to `assignmentFingerprint`: vendor, day, category, item, lines and a hash of the
   text, never the person's context, so a new answer elsewhere does not undo every decision). Deleting a
   receipt deletes its decision.

18. **A decision is claimed before the cell is written, and only over the record the run read** (review of
   #246). A person who answers while the model is asked, or a second run on the same receipt (an upload and
   "Zuordnungen entscheiden" at once, two quick edits), keeps what they wrote; the late answer is dropped
   and counted as `superseded`. The match is on the record's `decidedAt`, a millisecond stamp
   (`TIMESTAMP(3)`) that round-trips exactly; it is the version of the record, not an id to be swapped
   for one. Leaving "Privat" (the model replacing its own outdated "Privat", or a rule taking over) brings
   back the share kept from before, else the whole, as a manual edit does. A tools-page request starts no
   model call after 200 seconds.
19. **"Was ist das?" is a statement with a subject** (decision 8): `classification_rules.subject` (migration
   0052) holds the vendor's compared key, the text reads "<name>: <answer>", `label` holds the answer alone,
   one statement per subject (a new answer replaces it, an empty one deletes it). It reaches the assignment
   model only for that vendor's receipts; a statement about the person reaches all. The prompt text is
   unchanged, so what the replay measured still holds. Saving it decides the vendor's open receipts again,
   also those whose suggestion rests on the same facts; set and answered ones stay.
20. **The counterparty classifier** gets the answer as `personSays` and answers `what` (stored in
   `tax_counterparty_verdicts.what`, shown as "Die App hält es für: ..."). The answer joins the verdict's
   fingerprint only when given, so no stored verdict is redone on deploy; a new answer decides that
   counterparty again at once. A counterparty a person answered is never decided again: an answer about it
   changes the note, never the treatment (flaschenpost SE and eBay S.a.r.l. stay as set by hand).
21. **"Teils, teils" per payment.** In the spending overview a payment of a mixed counterparty follows the
   receipts linked to it: business where one is business (Universität counts on the business side of that
   split, as any link did before), private where all are private, unanswered while one is open; only the
   cents linked to a business receipt are business. One without a receipt is a question. The tax figures
   do not change: they count the receipts, which already carry their own assignment. Moving private
   payments between companies does not change either (`route.ts` keeps an unlinked mixed payment private).
   Linking a receipt by hand starts its assignment decision, and where no positions were read the stored
   reason starts with "Ohne gelesene Positionen, nur nach Anbieter und Text entschieden."
22. **The questions are grouped per counterparty.** Production on 2026-11-08 (read only), open year 2026:
   281 payments out without a receipt of counterparties the owner answered "Teils, teils" (PayPal Europe
   256, Amazon 22, eBay 2, Riverty 1), and more of counterparties the app itself filed as mixed (Apple,
   MILES, Telekom, freenet). One card each would bury the page, so "Teils, teils: welcher Beleg gehört zu
   welcher Zahlung?" lists each counterparty with its count, and "Zahlungen ansehen" opens its payments
   with "Beleg wählen" and "Beleg hochladen". PayPal is a payment service rather than a shop; whether it
   should stay "Teils, teils" is the owner's answer on the page.

## Paths (stateful-flow standard)

- Forward: upload, reading, rule or model decides, set or asked.
- Backtrack: a person changes an automatic answer: recorded as a correction, never decided again for
  that receipt; a re-read ("Seite neu lesen") or a changed vendor or line items invalidates the
  automatic decision (keyed to its inputs) and decides again, but never over a person's answer.
- Resume: a decision that failed or timed out leaves the receipt asked; the next run picks it up.
- Re-entry: running the open-receipts pass again changes nothing already decided.

## Measured (decision 6, replay of 2026-11-07)

What was replayed: every receipt of production whose assignment was set (1,326 in two workspaces), in
date order, each decided with only the answers of the receipts before it and the five statements of
decision 5 (for Whiz-Art Media, counted as stated from the start). Left out: 153 that a reading rule
decides (no evidence of the person) and 119 the app would not decide (meals, finance decisions and vendor
rules; their answers were context for the later receipts). Decided: 1,054 (Whiz-Art Media 761 business,
130 university, 110 private; the private workspace 53 private). There were no corrections yet, so the
replay measures the start, before the app has learned anything from them. The prompt was the app's own
(`scripts/assignment-replay.ts` builds it with `src/lib/assignment/prompt.ts` and `context.ts`), without
the total, which the export did not carry.

Accuracy per option, every answer (right, wrong, no answer):

| Model | Geschäftlich (761) | Universität (130) | Privat (163) |
|---|---|---|---|
| Haiku 5.5 | 743, 5, 13 | 15, 101, 14 | 107, 40, 16 |
| Sonnet 5.5 | 728, 3, 30 | 50, 48, 31 | 116, 17, 30 |

(Sonnet: one university receipt got no answer after retries, 1,053 decided.) The university receipts are
the weak spot: most of them are software and gear for the studies, and both models take them for
business, more so Haiku. Since the studies ended in spring 2026 (decision 5), new receipts rarely are.

Set automatically per threshold, Sonnet 5.5 (of 1,053): set, right, "Privat" on a business receipt (of the
business receipts set), "Geschäftlich" on a private receipt (of the private receipts set), any mistake:

| Threshold | Set | Right | Privat on business | Geschäftlich on private | Any mistake |
|---|---|---|---|---|---|
| 0.5 | 962 | 894 | 3 (of 731) | 16 (of 133) | 68 |
| 0.75 | 909 | 862 | 3 (of 715) | 9 (of 121) | 47 |
| 0.8 | 906 | 859 | 3 (of 713) | 9 (of 120) | 47 |
| 0.85 | 792 | 773 | 2 (of 669) | 3 (of 98) | 19 |
| **0.9** | **725** | **714** | **2 (of 624)** | **3 (of 88)** | **11** |
| 0.95 | 491 | 488 | 0 (of 460) | 0 (of 28) | 3 |
| 0.97 | 277 | 276 | 0 | 0 | 1 |

The same for Haiku 5.5 (of 1,054):

| Threshold | Set | Right | Privat on business | Geschäftlich on private | Any mistake |
|---|---|---|---|---|---|
| 0.75 | 960 | 833 | 2 (of 726) | 30 (of 131) | 127 |
| 0.9 | 776 | 728 | 1 (of 648) | 13 (of 93) | 48 |
| 0.95 | 472 | 465 | 0 (of 415) | 1 (of 51) | 7 |
| 0.97 | 90 | 90 | 0 | 0 | 0 |

Chosen: Sonnet 5.5 at 0.9 (decisions 9 and 10). Among the 725 it sets, "Privat" on a business receipt is
2 in 725 (0.28 percent) and "Geschäftlich" on a private one 3 in 725 (0.41 percent), both below the bar of
1 in 100. Read with care: the private receipts are few, so among the 88 private receipts it sets, 3 are
filed as business (3.4 percent of those); a single mistake more or less moves that share a lot. The cost of
the replay: Haiku 0.44 US dollars, Sonnet 6.80 (with the retries after a provider limit).

## Open questions

None for the owner. The threshold is decided by the replay (decision 6).
