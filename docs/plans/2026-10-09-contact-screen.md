---
title: Contact screen in the receipts app (wave 3)
summary: The contacts tab grows from a guest picker into a directory of people and organizations, with company details, links between them, merges, customer numbers, and a single-contact export. Completed 2026-10-10 with custom fields, the preferred contact method and the erasure of one contact, which follows the export and hold rule of the company erasure.
type: plan
status: completed
tags: [receipts, contacts, shared-model, screen, stateful-flow]
projects: [receipt-ocr-app, contacts]
date: 2026-10-09
---

# Contact screen in the receipts app (wave 3)

## Context

Wave 2 of the shared contact model moved the business-meal guest list onto the shared contacts
database (see `docs/plans/2026-10-09-shared-contacts-wave2.md`). Wave 3 is the contact screen:
the "Kontakte" tab can now manage organizations and their links to people, not only guests.

Terms used here:
- **Person** and **organization** are the two kinds of contact in the shared database.
- **Organization link**: a person can name one organization in the same company. Several people
  may share one organization.
- **Customer number**: a number from the company's counter, given once and never reused.
- **Printed copy**: the name and company printed on a meal record (kept on purpose, see wave 2).

## Decisions

1. **Directory in a new server module.** The existing guest picker keeps the narrow store
   (persons only). The directory uses the shared package directly, scoped to the company, in
   `src/lib/contacts/directory.ts`. It needs the shared database; with the switch off the
   directory says so instead of failing silently.
2. **Patch-based updates.** The package's update writes every column, so every edit reads the
   current record, applies the change, and saves against the version it read.
3. **Merge.** The package merges the loser into the winner. Then the meal guest rows that name the
   loser are repointed to the winner, a row that would then name the winner twice is removed, and
   printed text is not touched. Each step is repeatable: a merge that stopped after the first step
   is completed by running it again, and running it after completion reports "already merged".
4. **Erase is shown, not built.** The erase button asks for confirmation and then refuses with
   "not available yet". The rule for printed copies is the one from the company erasure build
   (`docs/plans/`, roadmap line "Company erasure hands over an export first"). No second rule is
   written here.
5. **Waiting for contacts-core 0.2.0.** Custom fields and the preferred contact method need the
   0.2.0 release. The form and the data layer are structured so those fields are added without
   changing the flows.

## Flows and their four paths (stateful-flow standard)

- **Pick (link a person to an organization):** forward (link); change an earlier input (edit the
  organization after linking, the link still holds); resume (a failed link leaves the person as
  it was, and linking again succeeds); re-entry (linking the same pair again changes nothing).
- **Create (organization or person):** forward; change an earlier input (a duplicate of an existing
  contact is refused and the existing one is named); resume (a save refused as stale asks for a
  reload, and saving after reload succeeds); re-entry (creating the same identity twice is a
  duplicate, not a second contact).
- **Merge:** forward; resume (a merge that stopped after the package step is completed by the
  guest repoint on the next run); re-entry (a second merge reports "already merged" and changes
  nothing more); change an earlier input (the winner and loser are chosen again before anything is
  written).
- **Erase:** disabled until the erasure build lands; the stub is tested to refuse without writing.

## Verification

- Unit tests with a fake of the package's per-company contacts, covering the four paths above.
- Database tests against a throwaway contacts database and receipts database.
- Typecheck, lint, unit tests, database tests green.

## Completed on 2026-10-10: fields, contact method, erase, badge

Built on `@marlinjai/contacts-core` 0.2.0, which applies the additive contacts migration 0002 when the
app starts.

- **Custom fields.** The company defines fields in the tab (text, number, date, yes or no, one option,
  several options, link). A field key is derived from its label and stays taken after archiving. An
  archived field keeps its stored values and refuses new ones. The form sends only the fields that
  changed, and an error the package returns is shown under the input it names.
- **Preferred contact method.** Email, phone, post or none, on persons and organizations. It is part
  of the package's full record, so every full-record update in this app carries it (the guest list
  store, the directory and the move helper). Custom field values are a patch in the package and are
  kept when left out. Tests prove that an edit of the name wipes neither.
- **Erase one contact.** One rule, shared with the company erasure (`settleGuestCopies` in
  `src/lib/erasure.ts`): the contact and its meal links go; the printed names on meals are removed only
  when the register is identical to the company's newest export, and held otherwise (link cleared,
  ten-year date). Corrected on 2026-10-10: the first version removed them whenever any export was on
  record, which was wrong for an export older than a later meal or correction. The
  confirmation says which of the two happens and how many meals are concerned. The contact must exist
  in the company before anything is touched, because printed copies are keyed by contact id alone.
  Persons of an erased organization stay, unlinked. The retention purge stays unscheduled: no lawyer
  has confirmed the ten-year period.
- **Tab badge.** It counted persons only, while the tab also lists organizations. It now counts both;
  the guest picker keeps offering persons only.

Four paths covered for defining a field, editing with fields, and erasing: forward, change an earlier
input, resume and re-entry (unit tests with the package's own field rules, component tests, and
database tests against layout 0002).

## Not in this plan

- Custom fields and preferred contact method (contacts-core 0.2.0).
- Erasure of one contact (waits for the company erasure build).
- Removal of the app's own contacts table and the switch (wave 4, after Marlin reads the report).
