import { describe, expect, it } from 'vitest';
import { sameVendor } from '../vendor';

describe('the same vendor written differently', () => {
  it('is the same with and without the legal form', () => {
    expect(sameVendor('A2 Hosting', 'A2 Hosting LLC')).toBe(true);
    expect(sameVendor('Musterfracht Express GmbH', 'Musterfracht Express')).toBe(true);
    expect(sameVendor('Beispiel GmbH & Co. KG', 'Beispiel')).toBe(true);
  });

  it('is the same in another case or with other punctuation', () => {
    expect(sameVendor('CAFE MORGENROT', 'Cafe Morgenrot')).toBe(true);
    expect(sameVendor('Leap.new', 'Leap New')).toBe(true);
  });

  it('is not the same for another name, or for a name that only starts alike', () => {
    expect(sameVendor('Laufkunde', 'Cafe Morgenrot')).toBe(false);
    expect(sameVendor('Muster', 'Musterfracht Express')).toBe(false);
  });

  it('is never the same for an empty name or one that is only a legal form', () => {
    expect(sameVendor('', '')).toBe(false);
    expect(sameVendor('GmbH', 'LLC')).toBe(false);
  });
});
