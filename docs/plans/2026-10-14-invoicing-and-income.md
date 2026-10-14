---
title: "Invoicing and income: one record per issued invoice, from creation to the money arriving"
type: plan
status: draft
date: 2026-10-14
summary: "Why the finance area shows no income for 2026, where an issued invoice is created and stored so it is entered once, how it reaches the income side on the day the money arrives, the numbering, what the small-business rule (section 19 of the value-added tax act) and the German electronic invoice duties mean here (checked against the finance ministry's letters), and the migration of the invoices of 2024 to 2026 that exist only as PDF files."
tags: [invoices, revenue, income, cash-basis, small-business, section-19, e-invoice, xrechnung, zugferd, numbering, payments, migration, books]
projects: [receipt-ocr-app, framer-clone]
---

# Invoicing and income

Companion plans: the finance and tax area
([2026-10-07-finance-tax-dashboard-and-advisory.md](2026-10-07-finance-tax-dashboard-and-advisory.md),
which built the income side described below) and the decided Books plan in the framer-clone
repository (`framer-clone/docs/plans/2026-08-15-books-receipts-invoices-integration.md`, which
put offers and invoices as documents into framer-clone and has not been started).

Real figures in this file are yearly totals only. This repository is public; the list of
single invoices (number, date, amount, payment day) lives in the owner's tax folder at
`Finanzen/Steuern/2026/ausgangsrechnungen-2024-2026.md`, and client names appear nowhere.

## 1. The problem in one paragraph

The finance area under Whiz-Art Media shows "Einnahmen 0" for 2026, so it cannot compute a
profit, a tax estimate or the small-business limit forecast. The reason is not a bug: the app
counts income from issued invoices it knows about, and it knows about none. All issued
invoices exist only as PDF files in the iCloud folder `Finanzen/Rechnungen Whizart/`, written
by hand in a Google Doc. Every new invoice therefore has to be typed twice (once as the
document, once into the app), which is exactly what has not happened.

## 2. What exists today (read on 2026-10-14)

### 2.1 The income side of the receipts app (built, works, empty)

- **Issued invoices are a list** (`TaxIssuedInvoice`, migration `0012_tax_revenue_vat`):
  number, issue date, total, tax, treatment (`small_business`, `standard`, `reduced`,
  `not_taxable`) and `declaredInYear` (an earlier return already counted it, so its payment is
  not income again). No client name by design. Entered through the "Einnahmen" tab
  (`src/app/app/finance/RevenueTab.tsx`), validated by `src/lib/tax/revenue-input.ts`.
- **Money received** comes from two places, merged in `src/lib/tax/service.ts`: a payment day
  typed in by hand (`TaxInvoicePayment`), or a bank payment linked to the invoice
  (`TaxPaymentLink.invoiceId`, from the payment imports of slice 3).
- **Cash basis is already the rule** (`src/lib/tax/compute.ts`): income counts on the day the
  money arrives, split by month; an unpaid invoice is "outstanding", not income. The turnover the
  small-business limits measure is summed before the `declaredInYear` exclusion, so an invoice
  declared in an earlier year still counts toward the limit of the year its money arrived, which
  is what section 19 asks (Abschnitt 19.2 of the value-added tax application decree: turnover is
  counted by consideration received).
- **The matcher** (`src/lib/tax/payments/match.ts`) links a payment to an invoice only when the
  invoice number appears in the transfer text; amount and date alone only produce a candidate
  a person confirms.
- **Section 19 status, its limits and the forecast** are built (status entries by date,
  `tax_status_changes`), as is regular value-added taxation for the day the status ends.
- **Known gaps on the roadmap**: an invoice holds one tax treatment, so an invoice with 7 and 19
  percent lines would be reported under one rate (roadmap line of 2026-10-10); recurring income
  around the turn of the year (the ten-day rule) is not built.

### 2.2 framer-clone: the decided invoice tier is not built

The Books plan of 2026-08-15 (decided 2026-08-16) designs `Customer`, `SalesDocument` (offer,
invoice, credit note in one table), lines, templates, numbering at issue and an append-only
event log, plus a read endpoint so the two apps exchange data. On 2026-10-14 none of it exists:
no `src/server/books/`, no `SalesDocument` model, last commit on main 2026-09-14. Its commerce
part is restricted to one shared schema until the multi-tenancy work (MT-18 in that repo) lands,
and it has no session guard on its commerce routes. What framer-clone does have is a careful
German tax model on storefront orders (reverse charge, rates in basis points, money in cents),
which an invoice under section 19 does not use. The repository is listed as active (the word
"deprecated" next to it in the knowledge-base roadmap of 2026-09-17 refers only to an old
install line of the secrets tool in its image).

### 2.3 The invoices on disk

- **Where**: `Finanzen/Rechnungen Whizart/`, one PDF per invoice, made with Google Docs (the
  Google Doc is the template; nothing editable is on disk). Invoices 1 to 27 predate the tax
  years in question; 28 to 61 cover 2024 to 2026.
- **Count and totals**: 2024: numbers 28 to 39, total 12,271.44, identical to the filed profit
  statement (counted by invoice). 2025: 40 to 50, total 4,837.00, all paid in 2025 (payment days
  in `Steuern/2025/Entscheidungen-2025.md`). 2026: 51 to 61, ten files, total 5,626.58; eight
  payments found in the bank export that ends on 2026-09-28 (five by invoice number in the
  transfer text, three by amount only); invoice 58 has no payment yet, 61 is newer than the
  export.
- **Every invoice from 28 on carries the small-business note** ("Umsatzsteuerfreie Leistungen
  gemäß §19 UStG"), shows no tax, and prints the tax number and the VAT identification number.
- **Numbering**: one running integer across the years (2024 ends at 39, 2025 at 50). Defects:
  no invoice 60 exists anywhere; the file of invoice 58 prints "Nr. 53" (a copy of 53's header);
  invoices 51, 53 and 58 also print a second mark "RE-2026-001/002/003" (the maintenance
  contract); invoice 40 prints the wrong year in its original (a corrected copy of 2026-10-06
  exists, as for 42, whose original printed a wrong total).
- **Missing on most invoices**: the service date or period. Payment terms contradict themselves
  on most ("zahlbar sofort" next to "innerhalb von 14 Tagen"); invoice 61 states 14 days and asks
  for the invoice number in the transfer.
- **No electronic invoice** (XRechnung or ZUGFeRD) was issued or received as a file anywhere in
  the work folder.
- The table "Gesamt Umsätze 2024" is not an invoice list: it holds three bank exports. The 2024
  invoice list is the filed profit statement (`Steuern/ELSTER-Export-2026-10-05/EUER-2024.txt`).

## 3. The law that applies, and what was checked

Checked against primary sources on 2026-10-14:

- **Section 19 limits** (finance ministry letter of 2025-03-18 on the small-business rule,
  Abschnitt 19.1 (2) of the application decree): small business applies when the turnover of
  the previous year did not exceed 25,000 euros and the turnover of the current year does not
  exceed 100,000 euros. The turnover is counted by money received (Abschnitt 19.2 (1)). The
  transaction that crosses 100,000 is itself already taxable, from that payment on. Crossing
  25,000 in a year ends the status on 1 January of the next year. Figures here: 2025 is 4,837,
  2026 so far is 5,626.58 issued, so 2026 and, unless 2026 passes 25,000, 2027 stay under
  section 19.
- **What an invoice under section 19 must show** (section 34a of the value-added tax
  implementing ordinance, read in its current wording on gesetze-im-internet.de): full name and
  address of issuer and recipient; the issuer's tax number, VAT identification number or
  small-business identification number; the issue date; quantity and kind of the goods or the
  scope and kind of the service; the amount in one sum with a note that the small-business
  exemption applies; "Gutschrift" when the recipient issues it. **No running number and no
  service date are required** under section 34a (the letter of 2025-10-15 also rewrites
  Abschnitt 14.5 (14): small-business invoices need no running number). The existing invoices
  therefore meet the law; their numbering defects have no tax consequence.
- **Electronic invoices, issuing** (finance ministry letter of 2025-10-15 on the mandatory
  electronic invoice, margin number 22 and the new Abschnitt 14.1 (6) of the application decree): an invoice of a small business
  under section 34a "can always be issued and transmitted as another invoice" (paper or, with
  the recipient's consent, a PDF; consent needs no form and can be given by simply accepting
  it). A small business never has to issue an XRechnung or ZUGFeRD invoice, in no year. It may
  send one without asking a domestic business customer.
- **Electronic invoices, receiving** (same letter, Abschnitt 14.1 (5)): since 1 January 2025
  every domestic business must be able to receive an electronic invoice, **including a small
  business under section 19**. An email mailbox is enough; no separate mailbox is needed. A
  business that cannot read one has no right to a paper copy instead. So the mailbox
  `expenses@marlinjai.com` already satisfies the duty; what is missing is that the receipts app
  can read what arrives there (section 4, D8).
- **Not verified**: the exact wording of the transition rules for issuing (Rn. 62 to 65 of the
  finance ministry letter of 2024-10-15: paper and PDF allowed until the end of 2026, until the
  end of 2027 for an issuer with a previous-year turnover up to 800,000 euros). The letter of
  2025-10-15 refers to them and the ministry's question page states the 800,000 figure, but the
  2024 letter itself could not be downloaded (the address returned a web page, the question page
  answered 503). These rules only matter on the day the section 19 status ends, and the app's
  preparation list for that day must quote them from the letter before it is relied on.

## 4. Decisions

Decided here because they follow from the facts above. Each can be overruled; the one
question that is the owner's is D1.

**D1. Where an invoice is created: the owner's decision (decision page card 1).** Two options,
with the same record shape and the same flow into income either way (D2 to D7 hold for both):

- **(a) In the receipts app, recommended.** An "Rechnung schreiben" editor next to the
  "Einnahmen" tab. The existing `TaxIssuedInvoice` grows into the document (D2); there is no
  second invoice table, no copy between apps, no machine endpoint, no service account, no tenant
  versus workspace mapping. The Books plan's schema design (sections 4.2 to 4.6 there: one
  document table, lines, snapshots frozen at issue, numbering at issue, append-only event log) is
  reused here, its storefront and tax-engine parts are not needed under section 19. framer-clone
  commerce keeps a later role: when a storefront order needs an invoice, it creates one through
  the same record (a pushed write into this app's invoice service, or a shared package if a
  second database ever needs it, per the "package and database first" rule). This reverses the
  framer-clone home of the Books plan (decided 2026-08-16) and what the owner said on
  2026-10-14, which is why it is his call.
  Reasons: every invoice from 2024 on is a section 19 invoice, and the forecast keeps it that
  way for at least 2026 and 2027, so the tax engine that made framer-clone the home is not used;
  the money, the bank payments, the matcher, the section 19 meter and the profit statement all
  live here; the framer-clone tier needs its phases 0 to 3 (tenant awareness, document domain,
  editor, rendering) plus a cross-app endpoint before the first invoice, and its commerce is still
  single-tenant.
- **(b) In framer-clone, as the Books plan says.** Then the Books phases 0 to 3 are built there,
  and this app keeps `TaxIssuedInvoice` as a read-only mirror of issued documents (a `source`
  column and the framer-clone document id, pulled by tenant over an authenticated machine
  endpoint, never edited here). Payments and links stay here. Cost: the endpoint, its
  service-account key and the mirror job, and the time until phases 0 to 3 exist.

Until the owner answers, nothing is built for D1; D2 to D8 do not wait for it except where a
step says so.

**D2. One record per issued invoice.** The record is created once, at the moment the invoice is
written, and everything else reads it: the PDF, the income side, the matcher, the limit
forecast. With D1 (a): `TaxIssuedInvoice` gains a status (`draft`, `issued`, `cancelled`), a
`source` (`register` for invoices entered from an existing PDF, `editor` for invoices written in
the app, later `commerce`), the service date or period, the due date, a contract reference
(D4), the stored PDF's file id, and child lines (position, description, quantity in thousandths,
unit, unit price in cents, discount, tax rate in basis points, treatment). The tax groups per
rate are derived from the lines, which also closes the roadmap gap of invoices with more than
one tax rate. An issued invoice is frozen: lines, recipient and sender are copied into snapshots
at issue and never recomputed; a correction is a cancellation invoice (Storno) plus a new one,
never an edit. The draft-to-issue flow is a multi-step flow, so the four paths of
`knowledge-base/standards/stateful-flow-testing.md` (forward, back and revise, resume, re-entry)
are its tests, as the Books plan lists them in its phase 2.

**D3. The recipient comes from the shared contacts database**, chosen in the editor; the
invoice table keeps a contact reference, never a name column. The recipient snapshot frozen at
issue (name and address, needed to reprint the invoice as sent) is stored with the issued
document only, follows the company export and the retention purge of the contacts work, and is
never shown in lists, logs or exports other than the invoice itself. The sender block (legal
name, address, tax number, VAT identification number, bank details) is a company setting, read
from the auth-brain company record where it holds the field; it is never in the repository.

**D4. Numbering: continue the one integer series, next number 62.** The series is continuous
since invoice 1, the filed 2024 return quotes "Rechnungs Nr. 28" and following, and continuity
is what an auditor expects even though section 34a does not demand it. The number is allocated
in the same transaction that issues the invoice, never at draft creation, from a counter row per
company (locked for the transaction), so an abandoned draft leaves no hole. The marks
"RE-2026-00x" printed on 51, 53 and 58 are a reference of the maintenance contract, not an
invoice number: they move to the contract reference field and are no longer printed as part of
the number. A year prefix (`RE-2026-0001`) is not introduced; it would break the series for no
gain.

**D5. Payment terms and the transfer reference.** Every invoice states "zahlbar innerhalb von 14
Tagen ohne Abzug" (payable within 14 days, no deduction; the default, changeable per invoice) and
asks for "Rechnung <number>" as the transfer reference, as invoice 61 already does. The
contradictory "sofort, rein netto" plus 14 days goes. The matcher needs this: a bare two-digit
number in a transfer text is too weak a signal, so the matcher is tightened to accept an invoice
number only as a whole token, either the whole reference or next to "Rechnung", "RE" or "Nr",
with a test where the number appears inside another figure.

**D6. Cash basis, the day the money arrives.** Unchanged from the finance area: an issued invoice
is outstanding until a bank payment is linked to it; income counts on the payment's booking day.
A link is made automatically only when the invoice number is in the transfer text and the amount
fits; otherwise the app proposes it and the owner confirms. A typed-in payment day stays possible
for money that never touches an imported account (cash). An invoice that is still unpaid 14 days
after its due date is listed in the finance area's open checks, which is the reminder.

**D7. The PDF.** Rendered on the server from the frozen record (HTML to PDF), stored in
storage-brain, its file id on the record; a reprint reproduces the same content from the
snapshots. A completeness test fails the build when a section 34a field is missing while the
company is under section 19, and checks the full section 14 (4) list (running number, service
date, tax per rate) once a status entry says regular taxation. The service date or period is a
field on every invoice anyway (cheap now, required later). Sending stays a manual act of the
owner (download or "send" from his own mailbox); a PDF by email is allowed under section 19
(section 3). An XRechnung or ZUGFeRD export is not built now: no customer has asked for one, and
a small business never has to issue one. It becomes a step of the preparation list the app
already shows before a section 19 limit is reached.

**D8. Receiving electronic invoices.** The duty is met by the mailbox (section 3); the gap is the
reader. A pure XRechnung arrives as an XML file with no picture to read, and a ZUGFeRD or
Factur-X invoice is a PDF with the same XML inside. The receipts reader must take the figures
from that XML (seller, date, number, net, tax per rate, total) before it falls back to reading
the page, and keep the XML file with the receipt as the original. This is independent of D1 and
gets its own roadmap line when the mailbox reading (finance plan, stage 1, "reading the expenses
mailbox") is built, because that is where such files first arrive.

**D9. Interim, until the editor exists.** The Google Doc stays the way an invoice is written,
and the same day the invoice is entered in "Einnahmen" (number, date, amount, small business).
That is double entry on purpose and is what this plan removes; it is the reason the editor is
step 2 and not later.

## 5. Migration of the invoices on disk

Source: the list in the tax folder (`Steuern/2026/ausgangsrechnungen-2024-2026.md`), read from
the PDFs. All entered as `small_business`, tax 0, `source = register`, through the existing
invoice service so the same validation applies. A number already present in the app (one of
them may have been typed in by an earlier session) is compared, not entered again: the unique
key on company and number refuses a second row, and a differing figure is reported.

1. **2026, invoices 51 to 61** (60 waits for the owner, card 2): the records first; they need
   nothing else and end "Einnahmen 0" at once (as outstanding). Then the payment links: from the
   2026 bank payments in the app, the five transfers that name the invoice number link on their
   own, the three amount-only matches (51, 53, 56) are offered as proposals for the owner. The
   2026 bank import is the other session's work (the 2026 import, task B); the links are made
   after its payments are in the app, never by typing a payment day for money the bank shows.
   Invoice 58 is recorded under 58 with a note that its PDF prints 53 (card 3).
2. **2025, invoices 40 to 50**: records with their payments; where the 2025 bank payments are in
   the app (they are, since the 2025 import) the payment is linked, otherwise the day from
   `Entscheidungen-2025.md` is typed. Check after: the 2025 income equals 4,837.00, the figure of
   the draft return. Invoices 40 and 42 are recorded with the corrected figures.
3. **2024, invoices 28 to 39**: records with `declaredInYear = 2024`, because the filed return
   counted them by invoice. Payments are linked where the bank shows them; a payment of an
   invoice of 31 December 2024 that arrived in January 2025 therefore adds to the 2025 limit
   turnover but not to 2025 income, which is right. Invoice 34 is an image-only PDF; its date is
   taken from the filed return or its bank payment. Check after: 2024 income in the app equals
   the filed 12,271.44 and 2025 income still equals 4,837.00.
4. **Not migrated**: invoices 1 to 27 (before the years the app holds). The PDFs stay where they
   are; each migrated record links its PDF as its original (stored like a receipt's file), so the
   app shows the document that was really sent.
5. **Gate**: the 2025 business figures of the finance area (business expenses 14,376.04 euros,
   265 receipts counted) must not move; only income appears.

Executed by a session after this plan is decided; steps 1 to 3 are data entry through the
running app and need no code. The figures in the checks are compared, not printed into this
repository.

## 6. Order of work

1. **Migration, steps 1 to 3 of section 5.** Ends "Einnahmen 0". No dependency on D1. The
   payment links of 2026 after the other session's 2026 bank import.
2. **D5's matcher tightening** and the open-check for overdue invoices (D6). Small, in this repo.
3. **The invoice document** (D2, D3, D4, D7) in the home the owner picks in D1. With (a), in
   this repo: schema migration (additive: columns and a lines table, existing rows become
   `register` invoices with one line each), the issue transaction with the counter, the editor,
   the PDF and its completeness test, the four flow paths. With (b), the Books phases 0 to 3 in
   framer-clone plus the mirror here.
4. **Reading electronic invoices** (D8), with the mailbox reading of the finance plan.
5. **Later, on a trigger, not on a date**: credit notes beyond cancellation, offers, an
   XRechnung export (when a customer asks or the section 19 status ends), invoices from storefront
   orders.

Verify for each code step: the repo's gates (`pnpm test`, `pnpm build`, `pnpm tsc --noEmit`,
`pnpm lint`) and, for step 3, the four flow tests named in the suite and the completeness test.

## 7. Waiting for the owner

On the decision page `~/software-dev/decision-pages/2026-10-14-invoicing-and-income.html`:

1. Where invoices are written (D1). Recommended: the receipts app.
2. Invoice 60: issued, cancelled, or a number skipped? Recommended, if it was never issued: the
   register records 60 as "not used" with a note, so the gap is explained.
3. Invoice 58 prints "Nr. 53" and is unpaid since 2026-07-10. Recommended: send the client a
   corrected copy under 58, which doubles as the payment reminder. A corrected copy is filed in the
   folder either way, as was done for 40 and 42.

## 8. Relationship to other plans

- **Books plan (framer-clone, decided 2026-08-15)**: with D1 (a), its invoice and customer tier is
  superseded by this plan and should be marked so there, with its storefront parts (invoice from
  an order) kept as the later step 5; with D1 (b), this plan defers to it for the document and
  keeps sections 3, 5 and D4 to D8.
- **Finance and tax area (this repo)**: this plan fills its income side; its "InvoiceSource"
  seam is the record of D2.
- **Shared contacts (this repo, 2026-10-09)**: the recipient of D3.
