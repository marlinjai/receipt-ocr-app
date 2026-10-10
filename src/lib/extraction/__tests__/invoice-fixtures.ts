/**
 * Text of invoices that arrive as a file with a text layer, in the layout the
 * columns of the page give it: a label and its value on one line with a gap
 * between them, or a label alone on its line and the value below.
 *
 * Every fixture is invented (customers, addresses, document and account
 * numbers are left out or made up), but each one keeps the vendor, the date
 * lines and the amount lines of a real invoice from the import of the 2025
 * purchases, where the reader found no date on 53 of 235 documents.
 */

/** The invoice date in a column with no colon, as DD-MON-YYYY; the service term below it is a period. */
export const ADOBE_DATE_IN_A_COLUMN = `                      Adobe Systems Software Ireland Ltd                     ORIGINAL        Invoice Information
                      4-6 Riverwalk
                      Citywest Business Campus                                      Invoice Number                   IEN0000000001
                      Dublin 24                                                     Invoice Date                     20-NOV-2025
                      Ireland                                                       Payment Terms                    PayPal
                                                                                    Currency                         EUR
            Bill To
            Erika Musterfrau
            GERMANY

 INVOICE

 Item Details
 Service Term: 20-NOV-2025 to 19-DEC-2025
 PRODUCT NUMBER      PRODUCT DESCRIPTION          QUANTITY UNIT     UNIT PRICE   NET AMOUNT     TAX RATE     TAXES     TOTAL
 00000001            Creative Cloud Pro           1 EA              29.40        29.40          19.00%       5.59      34.99

Invoice Total
                                                  NET AMOUNT (EUR)                    29.40
                                                  TAXES (SEE DETAILS FOR RATES)        5.59
                                                  GRAND TOTAL (EUR)                   34.99
                      Thank you for your business!                                     Page 1 of 1`;

/** No label at all: the date stands alone under the heading, the day with a full stop. The renewal a month later is no invoice date. */
export const APPLE_DATE_UNDER_THE_HEADING = `Invoice
8. March 2025
Sequence: 1-0000000001
Document: 000000000001

            iCloud                                                                         9,99 €
            iCloud+ with 2 TB (Monthly)                             Inclusive of VAT at 19 % 1,59 €
            Renews 8. April 2025

Billing and Payment
Erika Musterfrau                                 Subtotal                                 8,40 €
                                                 VAT charged at 19 %                      1,59 €
Germany                                          PayPal                                   9,99 €

You may contact Apple for a full refund within 15 days of a monthly subscription upgrade or
within 45 days of a yearly payment. Partial refunds are available where required by law.
TM and © 2026 Apple Distribution International Ltd., Hollyhill Industrial Estate, Hollyhill, Cork, Ireland`;

/** "Rechnungsdatum" and a German month abbreviation on one line with the total; the period of the overview repeats the day. */
export const GOOGLE_LABEL_AND_DATE_ON_ONE_LINE = `                                                                 Google Commerce Limited
Rechnung                                                         Dublin 4
                                                                 Ireland
Rechnungsempfänger
Erika Musterfrau
Germany
Details                                                          YouTube
..............................................................
Rechnungsnummer                           0000000001-14
..............................................................
Rechnungsdatum                            6. Sept. 2025          Gesamtsumme in EUR                                  7,49 €
..............................................................
                                                                 Übersicht für den Zeitraum 6. Sept. 2025

                                                                 Zwischensumme in EUR                                6,29 €
                                                                 Umsatzsteuer (19%)                                  1,20 €
                                                                 Gesamtsumme in EUR                                  7,49 €
Diese Rechnung wurde elektronisch und automatisch ohne Kasse erstellt.
                                                                                                             Seite 1 von 2
6. Sept. 2025
Transaktions-ID                 Beschreibung                                         Menge             Betrag (€)
YouTube Premium                                                                                              6,29
                                                                 Zwischensumme in EUR                                6,29 €
                                                                 Umsatzsteuer (19%)                                  1,20 €
                                                                 Gesamtsumme in EUR                                  7,49 €`;

/** "Rechnungsdatum" alone on its line, a dotted rule, the date on the line below. The billed month starts on the 1st. */
export const GOOGLE_LABEL_ABOVE_THE_DATE = `                                                                 Google Cloud EMEA Limited
Rechnung                                                         Dublin 4
                                                                 Ireland
Details
..............................................................
Rechnungsnummer                           0000000002
Rechnungsdatum
..............................................................
                                          31. März 2025          Gesamtsumme in EUR                                   4,83 €
..............................................................
                                                                 Übersicht für den Zeitraum 1. März 2025 - 31. März 2025

                                                                 Zwischensumme in EUR                                 4,06 €
                                                                 Umsatzsteuer (19%)                                   0,77 €
                                                                 Gesamtsumme in EUR                                   4,83 €
Google Cloud - Gebühren für März 2025                                                                                 4,06`;

/** The due date stands first and on the same line as the day of issue; the billed terms are periods. */
export const HOSTING_DUE_AND_ISSUED_ON_ONE_LINE = `Invoice #A-INV-000001
A2 Hosting
United States

€261.07 due Apr 28, 2025 - Pay online                               Issued Apr 29, 2025

Description                                                                       Amount
Web hosting
  12-month term (May 6, 2025 - May 6, 2026)                                      €208.31
Domain renewal
  12-month term (Apr 28, 2025 - Apr 28, 2026)                                     €11.08
                                                              Subtotal           €219.39
                                                              VAT (19%)           €41.68
                                                              Total              €261.07`;

/**
 * "Date of issue" above "Date due", both without a colon. The invoice is paid
 * from a credit balance, so the amount due is zero and the total is not.
 */
export const CURSOR_PAID_FROM_BALANCE = `Invoice
Invoice number 00000000-0005
Date of issue  2 February 2025
Date due       2 February 2025

Cursor                                   Bill to
United States                            Muster Media
                                         Germany

US$0.00 due 2 February 2025

Cursor Usage for January 2025

Description                                                               Qty   Unit price       Amount
1 o1 request * 40 cents per such request                                    1   US$0.40      US$0.40

                                                            Subtotal                             US$0.40
                                                            Total                                US$0.40
                                                            Applied balance                      -US$0.40
                                                            Amount due                           US$0.00
Anysphere, Inc.`;

/** The same layout with the month first and the due date two weeks after the day of issue, so that a test can tell the two apart. */
export const CURSOR_DUE_LATER = `Invoice
Invoice number 00000000-0006
Date of issue  February 13, 2025
Date due       February 27, 2025

Cursor                                   Bill to
United States                            Muster Media
                                         Germany

US$20.00 due February 27, 2025

Description                                                      Qty   Unit price       Amount
Cursor Pro                                                         1   US$20.00      US$20.00
  Feb 13 - Mar 13, 2025

                                             Subtotal                              US$20.00
                                             Total                                 US$20.00
                                             Amount due                            US$20.00
Anysphere, Inc.`;

/** German month names written out, "Ausstellungsdatum" for the day of issue, the due date three times. */
export const GERMAN_ISSUED_AND_DUE = `Rechnung
Rechnungsnummer MU-0001
Ausstellungsdatum 4. Januar 2025
Fällig am         18. Januar 2025

Agentur Beispiel                 Rechnungsempfänger
Deutschland                      Erika Musterfrau

178,50 € fällig am 18. Januar 2025

                                                       Preis pro Einheit                Betrag
Beschreibung                               Menge       (zzgl. Steuern)       Steuer   (zzgl. Steuern)
Eventfotos                                     1            150,00 €         19 %          150,00 €

                                                       Zwischensumme                     150,00 €
                                                       Netto                             150,00 €
                                                       USt. - Deutschland (19 % auf 150,00 €)   28,50 €
                                                       Summe                             178,50 €
                                                       Fälliger Betrag                   178,50 €
MU-0001 · 178,50 € fällig am 18. Januar 2025                                            Seite 1 von 1`;

/** An ordinal day in front of the amount, and no other date on the page. */
export const PADDLE_ORDINAL_DAY = `Tax invoice PAID
ClipBook
21st July 2025 - $17.84                                                                  via PayPal

Product                                                                   Qty           Amount
ClipBook licence                                                            1           $14.99
                                                                          Subtotal      $14.99
                                                                          VAT (19%)      $2.85
                                                                          Total         $17.84
                                        Paddle.com Market Ltd, London.
                                        © 2024 Paddle. All rights reserved.`;

/** Number and date share a line under one label each: reference, invoice, delivery note and order. The invoice date is the second of four. */
export const HARDWARE_NUMBER_AND_DATE_PAIRS = `                                                                                     Rechnung
Cyberport SE | Am Brauhaus 5 | 01099 Dresden

Muster Media                                                        Ihre Referenznr.                  0000000001 / 25.11.2025
                                                                    Kunde                             0000001
                                                                    Rechnungsnr./-datum               0000000002 / 27.11.2025
                                                                    Lieferscheinnr./-datum            0000000003 / 26.11.2025
                                                                    Bestellnr./-datum                 0000000004 / 25.11.2025
                                                                    Zahlart                           Paypal
                                                                    Lieferscheindatum entspricht dem Liefer- bzw. Leistungsdatum!

Pos.    Produkt- bzw. Leistungsbeschreibung             Menge USt. (%)       Einzelpreis         Betrag Netto
1       Notebook 14 Zoll                                    1    19             2.394,12            2.394,12
                                                             Summe Netto                       2.394,12 EUR
                                                             zzgl. 19 % USt.                     454,88 EUR
                                                             Gesamtbetrag                      2.849,00 EUR`;

/** An order page: only the day it was ordered and the day it was paid, the month abbreviated without a full stop. */
export const ORDER_PAGE_ORDERED_AND_PAID = `Bestellübersicht
Beispiel Elektronik GmbH

Bestellt am        23. Apr 2025                                                        Gutschein                    -EUR 37,49
Bestellnummer      000-0000001                                                         Gesamtbetrag                 EUR 112,50

Bezahlt am         23. Apr 2025
Zahlungsart        PayPal`;

/**
 * A leasing application. It states a monthly net rate and a one-off fee, and
 * no amount that is the total of this document: there is none to read.
 */
export const LEASING_APPLICATION = `MODULAT LEASING AG, Hannover
Original für MODULAT LEASING                                                                  ===000001===/H000001/1.0>>VT/OL/G/15.04.2025

 Leasingantrag -Unternehmen-
 Der Leasingnehmer beantragt bei MODULAT LEASING AG - nachfolgend ML genannt - den Abschluss eines Leasingvertrages über:

Firma                                 Muster Media                                                     Telefon
PLZ und Ort                           10115 Musterstadt

   Menge               Einzel-Komponenten                                              Hersteller, Typ
     1                     Smartphone                                      Apple iPhone 16 Pro, 512GB
                                                                                                                               Nutzungsdauer               mtl. Nutzungsgeb.
                                                                                                                                                                 netto
                                                                                                                                  36 Monate                    EUR 54,79
                   ML erhebt eine einmalige Bearbeitungsgebühr von EUR 50,00 zzgl. MwSt., die mit der ersten Rate eingezogen wird.
                                  Die Leasingobjekte sind ausschließlich für die unternehmerische Nutzung bestimmt.
Vertragslaufzeit                Der Leasingvertrag beginnt am 1. des Monats, der auf die Übernahme folgt. Erfolgt die Übernahme vorher, ist für die
                                Zwischenzeit je Tag 1/30 der monatlichen Leasinggebühr zu zahlen.
   Hinweis: Ich kann innerhalb von acht Wochen, beginnend mit dem Belastungsdatum, die Erstattung des belasteten Betrages verlangen.
Das Full-Service-Garantie-Paket besteht für alle Objekte eines        Diebstahl abzüglich eines Betrages von 25 % des
Leasingvertrages.                                                     Barpreises mindestens abzüglich EUR 250,00.`;

/**
 * The confirmation of that contract, scanned: it bills the first debit (rate,
 * the days before the start, the fee) with net, tax and gross, and names the
 * amount of every later month in one sentence below it.
 */
export const LEASING_CONTRACT_FIRST_DEBIT = `MODULAT LEASING AG
                                                                                            Hannover, am: 05.05.2025
     MODULAT LEASING Vertrag: L000001                              Rechnung Nr.: VA000001
     Guten Tag,
     Ihr Antrag auf Nutzung des/der Leasingsobjekte/s für die Dauer von zunächst 36 Monaten wird von uns
     angenommen. Es gelten die Bedingungen des Antragsformulars.
     Objektart             Hersteller           Bezeichnung
     Smartphone            Apple                iPhone 16 Pro, 512GB
     Übergabedatum: 03.05.2025 Vertragsbeginn: 01.06.2025
     Abbuchungstag: 1. jeden Monats, beginnend mit dem nächsten Monat.
     Zum 01.06.2025 buchen wir von Ihrem Konto ab:
           - monatliche Leasinggebühr                                                                                   54,79€              netto
           - anteilige Nutzungsgebühr je 1/30 (Zeitraum 03.05.2025 bis 31.05.2025)                                      51,14 €             netto
           - einmalige Bearbeitungsgebühr                                                                               50,00€              netto
           Netto-Gesamtbetrag                                                                                         155,93 €
           zzgl. 19,00 % Mwst.                                                                                           29,63€
           Brutto-Gesamtbetrag im 1. Monat                                                                             185,56 €
           Rechnungsbetrag ab dem 2. Monat: 54,79 € netto zzgl. 19,00 % Mwst 10,42 € = 65,21 € brutto`;

// ── Totals ───────────────────────────────────────────────────────────
//
// The same invoices as text recognition returns them: one cell per line, the
// labels of the totals block in one run and its amounts in another. On the
// import 26 of them were stored with a wrong total, mostly the net amount.

/** Dollars with German tax: "Total excluding tax" above the net, "Total" and "Amount due" above the tax and the two totals. */
export const OPENAI_TORN = `Invoice
OpenAI, LLC
United States
Bill to
Germany
$23.80 USD due January 2, 2025
Pay online
Description
ChatGPT Plus Subscription
Qty
Unit price
Tax
Amount
1
$20.00
19%
$20.00
Jan 2 - Feb 2, 2025
Subtotal
$20.00
Total excluding tax
$20.00
VAT - Germany (19% on $20.00)
Total
Amount due
$3.80
(€3.70)
$23.80
$23.80 USD
Page 1 of 1`;

/** A rate that is not a German one (25 percent, Sweden), printed on the invoice. */
export const LEAP_TORN = `Invoice
Bill to
Germany
$30.00 USD due August 18, 2025
Pay online
Description
Leap Pro 10X
Qty
Unit price
(excl. tax)
Tax
Amount
(excl. tax)
1
$24.00
25%
$24.00
Aug 18 - Sep 18, 2025
Subtotal
$24.00
Total excluding tax
$24.00
VAT - Sweden (25% on $24.00)
$6.00
(57.38kr)
Total
Amount due
$30.00
$30.00 USD
Page 1 of 1`;

/** Three labels in a run, five amounts in a run: nothing on the page pairs "Total" with its amount but the arithmetic. */
export const WEBFLOW_LABELS_THEN_AMOUNTS = `Webflow, Inc.
Invoice
1 × Site plans Basic Hosting Plan (at $18.00 / month), from Jan 10 2025 to Feb 10 2025
USD 18.00
USD 18.00
Subtotal
Tax (19.00%)
Total
Amount paid
Amount due
USD 18.00
USD 3.42
USD 21.42
USD 21.42
USD 0.00`;

/** A tax amount without its rate, in dollars: net, tax and their sum are all printed. */
export const NOTION_TAX_WITHOUT_RATE = `Notion Labs, Inc.
Invoice
$26.18
Plus plan
$22.00
$0.00
Tax
Total Due
$4.18
$0.00
$26.18
Subtotal
$22.00
Tax will vary based on your jurisdiction.`;

/** The column heading "Total" stands above the line items; the invoice total is the last one. The tax amount is not printed. */
export const HOSTING_TOTAL_AS_A_COLUMN_HEADING = `Invoice #A-INV-000002
A2 Hosting
Description
Total
Domain renewal one
€9.47
Domain renewal two
€9.47
Subtotal
€18.94
Total
€22.54`;

/** A long usage invoice: the amount due opens the page, the totals block is two pages down, and a refund note names a limit of $200.00. */
export const CURSOR_USAGE_HEADLINE_ONLY = `Invoice
Cursor
US$19.22 due October 29, 2025
Pay online
One-time Transitionary Invoice (2025-10-01 to 2025-10-26).
Qty
Unit price
Amount
Mid-month usage paid for October 2025
1
US$180.78
US$180.78
Refund because the last hard limit in the month was $200.00, but usage reached
$200.33 (likely because of processing delays).
1
-US$0.33
-US$0.33
468 token-based usage calls
1
US$30.20
US$30.20
Description`;

/** An earlier balance added to the invoice: the amount due is 20.40, the invoice total 20.00. */
export const CURSOR_BALANCE_ADDED_TORN = `Invoice
Cursor
US$20.40 due February 27, 2025
Pay online
Description
Cursor Pro
27 Feb - 27 Mar 2025
Qty
Unit price
Amount
1
US$20.00
US$20.00
Subtotal
US$20.00
Total
US$20.00
Applied balance
Amount due
US$0.40
US$20.40
Anysphere, Inc.`;

/** The same invoice as CURSOR_PAID_FROM_BALANCE, torn: nothing is left to pay, the total is 0.40. */
export const CURSOR_PAID_FROM_BALANCE_TORN = `Invoice
Cursor
US$0.00 due 2 February 2025
Cursor Usage for January 2025
Description
1 o1 request * 40 cents per such request
Subtotal
Qty
Unit price
Amount
1
US$0.40
US$0.40
US$0.40
Total
US$0.40
Applied balance
-US$0.40
Amount due
US$0.00
Anysphere, Inc.`;

/** A promotion taken off after the tax lines: net and tax add up to "Total", what was paid is "Grand Total". */
export const MARKETPLACE_PROMOTION_AFTER_TAX = `Order Summary
Amazon.de
                                                        Item(s) Subtotal:    €167.78
                                                        Postage & Packing:   €0.00
                                                        Total before VAT:    €167.78
                                                        Estimated VAT:       €31.88
                                                        Total:               €199.66
                                                        Promotion Applied:   -€1.96
                                                        Grand Total:         €197.70`;

/** A customs invoice: duties and import tax carry no value-added tax, the service fees do. The tax lines cover 57,09 of 226,14. */
export const CUSTOMS_TAXED_AND_UNTAXED = `Beispiel Express GmbH
  Rechnungsdatum:  06.05.2025
  Zölle (ZOLLEU)                                25,41       Z      25,41
  Einfuhrumsatzsteuer (EUSt)                   143,64       Z     143,64
  Zollservice und Zusatzleistungen              47,97     9,12     57,09
  Gesamt                                       217,02     9,12    226,14
  Duty Tax Processing                           12,50 A
  Zollbedingte Lagerung 3 Tag(e)                35,47 A
  Gesamt                                        47,97
  Aufstellung Mehrwertsteuer
  A   19,0%                                     47,97     9,12
  Z   DUTY-VAT  0,0%                           169,05     0,00
  Summe MWSt.                                    9,12
  Fälligkeitsdatum: 13.05.2025
  Gesamtbetrag (EUR)                           226,14`;

/** The same order summary torn: five labels in a run, their amounts further down, the promotion with its minus sign. */
export const MARKETPLACE_PROMOTION_TORN = `Order Summary
Amazon.de
Item(s) Subtotal:
Postage & Packing:
Total before VAT:
Estimated VAT:
Total:
Promotion Applied:
Grand Total:
Softbox
€96.00
Light stand
€71.78
€167.78
€0.00
€167.78
€31.88
€199.66
-€1.96
€197.70`;
