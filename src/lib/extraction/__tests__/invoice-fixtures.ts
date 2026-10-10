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
