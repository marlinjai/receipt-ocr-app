/**
 * Recognized text of receipts, as text recognition returns it for a scan.
 *
 * Every fixture is invented (names, addresses, numbers), but each one keeps
 * the LAYOUT of a real receipt from the first live upload that the old reader
 * got wrong: the order of the lines, where labels and amounts were torn
 * apart, which numbers look like money and are not.
 */

/** Receipt numbers with a decimal point; a tip paid on top; the tax line written out in one sentence. */
export const CAFE_WITH_RECEIPT_NUMBERS = `Cafe Morgenrot
Laufkunde
* RECHNUNG *
iPad1/630652-Service
Duplikat C916752.448
A916752.8837
19.02.25, 17:04:11
Co Working, Tisch 30
Rechnung für Quittung R916752.8746
1
Kräutertee
3.50 3.50
4
Nussschnitte
4.50 18.00
1
Käsekuchen
5.50
5.50
Espresso Macchiato
2.70
2.70
1 Stunde
1.00
6.00
€ 58.70
Summe
Kassen Payments
| Referenz LYZOGAYEBKXA
Trinkgeld
| Bezahlter Betrag
MwSt. 19% auf 49.33: € 9.37 (58.70)
€ 61.40
€ 2.70
€ 58.70
31/314/02212
Besten Dank für Ihren Besuch!
10439 Musterstadt
TSE-Signatur: auWDjySe/8JvHX7CM7VuDe7K2095/GR9b`;

/** Net, tax and gross printed in a block below their labels. The old reader took the tax for the net: 526 percent. */
export const BREAKFAST_LABELS_ABOVE_VALUES = `das fruehstueckshaus
526 Gastronomiebetrieb
Beispielstraße 26
10435 Musterstadt
#0001
Restaurant
09.02.2025
Tisch 73
RechnungNr.: 5432
BelegNr.: 5756
1
Classic
*14.90
*14,90 IH 1
1
Special
*13.90
*13.90 IH 1
1
Matcha Latte
*5,40
*5,40 IH 1
Zwischensumme
Euro-Total
*34.20
*34,20
Netto
MwSt
Brutto
MwSt. 19% *28,74
MwSt
*5,46
*34.20
*5.46
St.-Nr. 27/138/50536
Es bediente Sie BEDIENER 2
Erste Bestellung: 09.02.2025 14:35`;

/** Two tax rates; a slogan as the first line; the name on a line with "Inh."; the logo in fragments. */
export const FOODBAR_TWO_RATES = `Since 2016
ANTASTIC
OOD - BAR
Fantastic Foodbar Inh.
K.M.K.
Beispielallee 126, 10437 Musterstadt
14:31:13 21.03.2025
Rechnung Nr.2-42883
2x Cappuccino Singl
2,50 €
6,00 € B
0,50 €
A
7,90 € 7,90 €
B
+ Hafermilch
1x 36 Avocado (M)
+ Kräuter M
1x 36 Avocado (L)
Total
Gegeben (Bar)
11,90 € 11,90 € B
11,90 € 11,90 € B
37,70 €
37,70 €
USt.%
Brutto
Netto
USt.
A=19%
1,00 €
0,84 €
0,16 €
B=7%
36,70 €
34,30 €
2,40 €
Bedient von: Master
Tisch: To Go 1
Web: www.fantastic-foodbar.example
St.Nr.: 31/390/01268`;

/** The name set in three short lines, then again in capitals. */
export const INDIAN_NAME_IN_THREE_LINES = `Indisches
Restaurant
Shanti
SHANTI
INDISCHES RESTAURANT
BEISPIELSTR. 32
TELEFON: 030-000 00 00
STEUER-NR.: 31/480/65079
RECHNUNG
Tisch #
1 271.TOFU MADRAS
1 268 TOFU PALAK
10405 MUSTERSTADT
€ 9,50
€ 8,50
1 44.CHAPATI
€ 2,20
3 45.PAPADAM
0,80
€ 2,40
1 MANGO LASSI 0,2
€ 3,80
8 Total
Netto MwSt19%
MwSt 19%
VISA
€30.40
€ 25,55
€ 4,85
€ 30,40
Dienstag 18-3-2025 22:09:22
#000099 L0001 Bediener 1
Angaben zum Nachweis der Höhe
und der betrieblichen Veranlassung
von Bewirtungsaufwendungen
Bewirtete Person(en)
Anlass der Bewirtung`;

/** Total, tip and grand total as three labels, then their three amounts; one tax group. */
export const THAI_TOTAL_TIP_GRAND_TOTAL = `Bangkok Garten
Est. 2010
Beispielstr. 22
10405 Musterstadt
Tel: 0170 0000000
Rechnung Nr.2-16767
21:09:45 02.04.2025
1x Wasser mit 0,75L 6,50 € 6,50 € A
1x Gai Satay
1x Pad Thai
Total
Trinkgeld
Gesamt
Gegeben (Karte)
8,90 €
8,90 € A
15,90 €
15,90 € A
13,90 €
13,90 € A
45,20 €
4,80 €
50.00 €
50,00 €
USt.%
Brutto
Netto
USt.
A=19%
45,20 €
37,98 €
7,22 €
Bedient von: Fen
Tisch: Tisch 18`;

/** The only printed total includes the tip; net and tax add up to a sum that is not printed. */
export const GRILL_TOTAL_INCLUDES_TIP = `Grillhaus Beispiel - Ocakbasi
Beispielstraße 177
10999 Musterstadt
Bestellung Nr. 4
Rechnung Nr 1007
1 x Cola 0.2l
1 x Ayran 0,3l
1 x Vorspeise
1 x Grillteller
Trinkgeld / TIP
******************
Total
******
3.00 3
3.50 3
9,00 1
28,50 1
4.40
*******
48,40
Nettoumsatz
Steuer summe
36,97
7,03
Mwst 19% Speisen
Verkäufe 19% inkl. Speisen 37,50
Verkäufe 19% inkl. Getränke 6,50
Mwst 19% Getränke
Trinkgelder etc.
Karte 1
5.99
1,04
4.40
48,40
Seq.-Nr.: 77826 | S/N: 3103920
Beginn/Ende: 9.10.2025 12:47 | 9.10.2025`;

/** A tip that happens to be seven percent of the bill: it must not be read as a tax line. */
export const RISTORANTE_TIP_LOOKS_LIKE_TAX = `RISTORANTE
ESEMPIO
Rechnung Nr. 1015
1. Kopie
1 x Acqua Naturale 0, 75l
7,00 1
2 x Carpaccio
29,80 1
1 x Gnocchi
1 x Pizza
Trinkgeld / TIP
*****
Total
***
9.82
*******
150,12
15,90 1
19,90 1
Nettoumsatz
117,90
Steuer summe
22,40
Verk. 19% ink.
140,30
1
Mwst 19%
22,40
1
Trinkgelder etc.
9,82
Kartenzahlung
150,12
Seq.-Nr.: 28260 | S/N: 3102445
21:39 21.11.2025 1
Bewirtungsaufwand-Angaben`;

/** A bar: "Server:" is the waiter. Two tax groups at one rate; only their common total is printed. */
export const BAR_WITH_SERVER = `Hopfen Retail Germany GmbH
Hopfen Musterstadt Mitte
Beispielstrasse 29
Server: Alex
05.12.2025
Table 13/1
4:01 PM
Guests: 1
30025
500 Pale Ale
6.80
PNT Lager
6.80
Nachos
12.95
Parma Pizza
13.95
Total
CARD
Balance Due
VAT Breakdown
40.50
40.50
0.00
FOOD:
26.90
HOUSE DRAUGHT:
6.80
AF DRAUGHT:
6.80
19.00% Net: 22.61 Tax: 4.29
19.00% Net: 11.43 Tax: 2.17
VIELEN DANK FÜR DEINEN BESUCH!
Steuernummer 045/229/80042
Transaktionsnummer: 4001234
Anfangsdatum 2025-12-05 16:01:04`;

/** A taverna with none of the words the old keyword list knew. */
export const TAVERNA = `TAVERNA BEISPIEL
Beispiel Str. 73
12051 Musterstadt
Tel.: 030 / 00 00 000
www.taverna-beispiel.example
TISCH: 102
1 x 38,00
MIXPLATTE
1 x 2,80
MINERALWASSER 0,2
1 x 4,50
LIMONADE
Total
Umsatz 19% exkl.
MwSt 19%
BAR
Datum und Zeit: 02.05.2025
38,00 A
2,80 A
4.50 A
45,30 EUR
38,07 EUR
7,23 EUR
45,30 EUR
Seq.-Nr.: 84562 | S/N: 2005193
Beginn/Ende: 02.05.2025 21:19 | 02.05.2025 22:35`;

/** A scan cropped above the item list: the head with the name is missing. */
export const CROPPED_HEAD = `+ mit Haferdrink
Beispielstraße 10
10178 Musterstadt
Rechnung Nr.1-51923
2x Heiße Schokolade
1x Matcha Latte
14:38:23 11.12.2025
4.50 €
9,00 € A
5,80 €
6,20 € A
1x Bagel
3,20 €
3,20 € A
Total
Trinkgeld
32.60 €
2,40 €
Gesamt
Gegeben (Kartenzahlu
USt.%
Brutto
A=19%
Netto
32,60 €
32,60 €
27,39 €
35,00 €
35,00 €
USt.
5,21 €
Bedient von: Kim
Tisch: Theke`;

/** An online order: the total and the tax it includes, the net never printed; a misread logo as first line. */
export const ONLINE_ORDER_TAX_INCLUDED = `Xx40
SHOPIX
SHOPIX
To prevent excess packaging waste, we do not include paper receipts.
Order summary
Order ID:
Order time:
Item(s) total:
Shipping:
Order total:
Includes VAT of 3,58€
Shipping time
Delivered by Nov 19, 2025
Nov 7, 2025
19,43€
2,99€
22,42€
Payment method
Paid on Nov 7, 2025`;

/** A dollar invoice: subtotal, discount and total, each label above its amount. The old reader took the subtotal. */
export const DOLLAR_INVOICE_WITH_DISCOUNT = `Example Courses
Details
Invoice #29905832
Nov 26, 2025
From
Example Courses
Items
Item
Offer
Amount
Premium Package
Single payment
$450.00
Summary
Subtotal
$450.00
Discount: BLACKFRIDAY (20% off)
-$90.00
Total
$360.00`;

/** A total with the tax table in one row: rate, gross, net, and the tax above it. */
export const THAI_TAX_TABLE_ROW = `ThaiHaus
ito d
ThaiHaus
Beispielstraße 13
33330 Musterstadt
01.08.2025 - 19:03 Uhr
Rechnungsnummer: 100200300
Kassen ID: 1
Tisch: 12
Artikel
Einz.-Pr. Ges.-Pr.
1X 05_Gyo Tod
5,40 €
5,40 €
1X
13_Pad Thai
15,90 €
15,90 €
Steuerübersicht
Net
Steuern
7,74 €
ID Steuern% Total
1 19,00% 48,50 € 40,76 €
Gesamt: 48.50 €
Gegeben Bar: 48,50 €
Zurück: 0,00 €
Bewirtungsaufwand - Angaben nach
Par. 4, Abs. 5, Ziffer 2, EStG`;
