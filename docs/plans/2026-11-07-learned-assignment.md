---
title: Assignment decided by a model that learns the person
summary: Who bears a receipt's cost (Geschäftlich, Universität, Privat) is decided by a model that knows the person: facts they state, how they answered each vendor before, and the corrections they made. A confident answer is set automatically and marked as such, an unsure one stays asked with the model's suggestion. The context grows from every answer, so a new user starts with document evidence only and the app learns them over time. Measured on every receipt that already has a person's answer before it is switched on.
type: plan
status: decided
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

## Paths (stateful-flow standard)

- Forward: upload, reading, rule or model decides, set or asked.
- Backtrack: a person changes an automatic answer: recorded as a correction, never decided again for
  that receipt; a re-read ("Seite neu lesen") or a changed vendor or line items invalidates the
  automatic decision (keyed to its inputs) and decides again, but never over a person's answer.
- Resume: a decision that failed or timed out leaves the receipt asked; the next run picks it up.
- Re-entry: running the open-receipts pass again changes nothing already decided.

## Open questions

None for the owner. The threshold is decided by the replay (decision 6).
