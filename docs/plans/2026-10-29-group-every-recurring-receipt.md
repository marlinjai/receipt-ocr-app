---
title: Every recurring receipt in its group, and no empty group left
summary: The automatic grouping also groups private receipts (in groups of their own), finds the group of a key by the receipts in it rather than by its name, merges a second group of the same key into the larger one, and every group left without a receipt deletes itself, the way it does in Notion. A group is only made with receipts in it.
type: plan
status: completed
tags: [receipts, groups]
projects: [receipt-ocr-app]
date: 2026-10-29
---

# Every recurring receipt in its group, and no empty group left

## Why

On 2026-10-29 the owner showed three screenshots of the Whiz-Art Media table: YouTube Premium
receipts for every month of 2025 sat loose at the top level, and iCloud receipts were partly in a
group and partly not. His words: "put all other receipts that can be grouped into groups for all
years", and, about a group he saw left empty, "empty groups should delete themselves automatically
like in Notion".

What the data showed, on production:

- **YouTube Premium** is assigned "Privat". The rule of 2026-10-14
  ([docs/plans/2026-10-13-dashboard-load-and-grouping.md](2026-10-13-dashboard-load-and-grouping.md))
  grouped only receipts that count for tax (Geschäftlich, Universität).
- **iCloud, August 2026**: same vendor, item, year and assignment as the seven receipts in the
  2026 group, and still loose. The group is called "Apple Distribution International Ltd., iCloud+
  2 TB, 2026": it kept the vendor its first receipts had, and the vendor on them has since been
  corrected to "Apple". The grouper looked for a group by the name the key would give it
  ("Apple, iCloud+ 2 TB, 2026"), found none, and a single loose receipt never makes a group.
- **iCloud, 2025**: two groups for one subscription ("Apple, iCloud+ 2 TB, 2025" and "Apple,
  iCloud+ mit 2 TB, 2025"), and loose receipts whose vendor or item is spelled differently
  ("Apple iCloud", "iCloud+ 2 TB Abo", "iCloud+ Abo"). The reader spells one subscription several
  ways.
- **3D AI Studio, 2026**: a group left empty after its receipts were moved; nothing removes it.

## Decisions (the owner, 2026-10-29)

1. **Every receipt that can be grouped is grouped, for every year**, private ones included.
2. **An empty group deletes itself automatically**, like in Notion.

## Decision (the owner, 2026-10-30): one group per vendor and year

Groups of one vendor still appeared twice, from another wording of one subscription (Patreon, Notion)
or from two plans (Google Workspace Business Starter and Standard): "they can go into one group".
The key is now vendor, year and assignment. What recurs is still decided by the item: a receipt
joins when its vendor and item appear at least twice in the year, so a one-off purchase stays loose.
A group that comes to hold several items is named "Vendor, Year". On the production data of
Whiz-Art Media this took 143 groups to about 91. Decided in building, say so if you disagree:
one rule without exceptions, so Telekom's landline and mobile, and Apple's iCloud and Microsoft 365,
also share their vendor's group; business and private stay apart, as before.

## Decisions (taken while building, 2026-10-29, say so if you disagree)

3. **The assignment is part of the key.** Business and private receipts of one vendor and item
   never share a group: money that counts for tax and money that does not stay apart, so a group's
   sum is always of one kind. Unassigned receipts still wait until they have an assignment, and
   business meals stay in the meal register.
4. **When two keys come to one name, the second group carries its assignment behind the name**
   ("OpenAI, ChatGPT Plus, 2024, Privat"). This also covers two vendors whose names are cut to the
   same length; before, the second key waited for a person.
5. **The group of a key is the group its receipts lie in**, whatever it is called. Groups holding
   nothing but that key come first, then the one holding most of them. A group with no receipts is
   still found by its name. This is what puts the August iCloud receipt into its group.
6. **A second group of the same key gives its receipts to the larger one**, when it holds nothing
   but that key. A group a person filled with several keys (a trade fair, a client) is theirs and is
   never emptied by the grouper.
7. **Empty means: no receipt that is not archived.** A group goes the moment it becomes empty: when
   its last receipt is taken out, moved into another group, deleted or archived. The grouper, which
   runs on every dashboard load, also sweeps any empty group that some other path left behind. The
   group goes through the receipts' own delete, so everything hanging off its row id goes with it,
   and an archived receipt that still pointed at it is put at the top level (it would otherwise
   point at a row that is gone). A group a payment is linked to is never counted as empty.
8. **A group is made with its receipts.** "Neue Gruppe" is offered only with receipts selected
   ("Erst Belege auswählen" otherwise), and the service refuses an empty group (`no_receipts`). An
   empty group made on purpose would vanish on the next load, which would read as a bug.
9. **Spelling variants are corrected in the data, not guessed by the key.** The key stays "equal as
   written" (the rule of 2026-10-14: nothing is guessed or merged). "Apple iCloud" and "Apple", or
   "iCloud+ mit 2 TB" and "iCloud+ 2 TB", are made one by correcting the receipts' vendor and item
   on production, each change listed in the report to the owner.

## Open

The reader will spell the next iCloud receipt its own way again, and a data correction does not
reach a receipt that arrives tomorrow. Teaching the reader one spelling per vendor (from the
contacts the receipts already link to, or from the spelling of the vendor's earlier receipts) is
the lasting fix; it is a change to the reader, not to the grouping, and is a line of its own on
ROADMAP.md.

## Reality (2026-10-29)

Built as decided. `src/lib/groups/auto.ts` holds the planner (key with assignment, group found by
its receipts, merge of pure groups, assignment behind a taken name), `src/lib/groups/empty.ts`
removes empty groups, called by `moveIntoGroup`, `removeFromGroup` (`src/lib/groups/service.ts`),
the receipts' delete (`deleteReceiptRows` in `src/lib/meals/service.ts`, inline, since this module
imports the groups' links), the dashboard's archive (`archiveRow` in
`src/app/app/dashboard/actions.ts`) and the grouper's sweep (`src/lib/groups/auto-service.ts`).
Tests: the planner in `auto.test.ts`, the four paths of a group in `service.test.ts` (forward,
taken out and moved, reloaded, after the end), and against a database in `auto-service.dbtest.ts`
and `service.dbtest.ts` (private apart from business, a renamed group found by its receipts, two
groups of one key merged and a second run changing nothing, each way a group can empty, the sweep
with an archived receipt).
