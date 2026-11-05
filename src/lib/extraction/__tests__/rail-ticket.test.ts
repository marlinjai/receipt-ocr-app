import { describe, expect, it } from 'vitest';
import { extractReceiptFields } from '@/lib/extract-receipt-fields';
import { chooseVendor, readVendor } from '../vendor';

/**
 * Deutsche Bahn online tickets as the text recognition returns them (from
 * production, 2026-11-05, names and numbers replaced). The logo "DB" is too
 * short to count as a name, so the reader took the next line: the carrier
 * code "CIV 1080" on three tickets, the handling note "Barcode bitte nicht
 * knicken!" on two.
 */
const TICKET_WITH_NOTE_ON_TOP = [
  'Barcode bitte nicht knicken!',
  'DB',
  'CIV 1080',
  'ICE Fahrkarte',
  'Online-Ticket',
  'Gültigkeit: 03.08.2026 00:00 Uhr bis 05.08.2026 03:00 Uhr',
  'Super Sparpreis Europa (Einfache Fahrt)',
  'Einfache Fahrt Innsbruck Gütersloh Hbf',
  'Via: <1181>Jenbach*Kufstein<1080>M*(S*KA*KO',
  'Gesamtpreis 69,99 € Gebucht am 19.07.2026 um 21:07 Uhr.',
  'Dieses Dokument ist nicht vorsteuerabzugsfähig.',
  'Erika Mustermann',
  'Auftragsnummer: 100000000001',
].join('\n');

const TICKET_WITH_CODE_ON_TOP = [
  'DB',
  'CIV 1080',
  'ICE Fahrkarte',
  'Online-Ticket',
  'Gültigkeit: 13.02.2026 00:00 Uhr bis 14.02.2026 10:00 Uhr',
  'Super Sparpreis (Hinfahrt)',
  'Gesamtpreis 24,99 € Gebucht am 14.01.2026 um 12:34 Uhr.',
  'Barcode bitte nicht knicken!',
  'Erika Mustermann',
  'Auftragsnummer: 100000000002',
  'Es gelten die nationalen und internationalen Beförderungsbedingungen der DB AG.',
  'Alle Bedingungen finden Sie unter www.bahn.de/agb.',
].join('\n');

describe('a rail ticket is issued by the carrier its code names', () => {
  it('the CIV code names Deutsche Bahn, whatever stands above it', () => {
    expect(readVendor(TICKET_WITH_NOTE_ON_TOP)).toEqual({ vendor: 'Deutsche Bahn', confidence: 'confirmed' });
    expect(readVendor(TICKET_WITH_CODE_ON_TOP)).toEqual({ vendor: 'Deutsche Bahn', confidence: 'confirmed' });
    expect(extractReceiptFields({ fullText: TICKET_WITH_NOTE_ON_TOP, blocks: [], confidence: 0.9 }).vendor).toBe('Deutsche Bahn');
  });

  it("the model's operating company does not replace the carrier", () => {
    const reading = readVendor(TICKET_WITH_CODE_ON_TOP);
    expect(chooseVendor(reading, 'DB Fernverkehr AG', TICKET_WITH_CODE_ON_TOP).vendor).toBe('Deutsche Bahn');
    expect(chooseVendor(reading, 'Barcode bitte nicht knicken!', TICKET_WITH_CODE_ON_TOP).vendor).toBe('Deutsche Bahn');
  });

  it('a code only in the route, or an unknown code, names no carrier', () => {
    const routeOnly = ['Musterbahn Reisen GmbH', 'Musterweg 1', '12345 Musterstadt', 'Via: <1080>M*N'].join('\n');
    expect(readVendor(routeOnly).vendor).toBe('Musterbahn Reisen GmbH');
    expect(readVendor(['CIV 9999', 'Musterbahn Reisen GmbH'].join('\n')).vendor).toBe('Musterbahn Reisen GmbH');
  });

  it('the handling note and the code are never a name', () => {
    expect(readVendor(['Barcode bitte nicht knicken!', 'Musterbahn'].join('\n')).vendor).toBe('Musterbahn');
    expect(readVendor(['CIV 9999', 'Musterbahn'].join('\n')).vendor).toBe('Musterbahn');
  });
});
