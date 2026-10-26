import { describe, expect, it } from 'vitest';
import { merchantName } from '../merchant';
import { counterpartyKey } from '../service';

/** The spellings are the shapes card and wallet payments name their merchant in; order codes are invented. */
describe('the merchant of a counterparty', () => {
  it('cuts the order code behind a merchant star, so one shop is one counterparty', () => {
    for (const label of ['AMAZON* KT2PC3H85', 'AMAZON* B05ZJ4F54', 'AMZN Mktp DE*N393Q1VQ5', 'AMZN Mktp DE', 'AMZN Mktp IT', 'WWW.AMAZON.DE', 'Amazon.it', 'AMAZON']) {
      expect(counterpartyKey(label)).toBe('amazon');
    }
    for (const label of ['AMAZON PRIM* RM6YU97N4', 'AMZNPrime DE*4L6RG9515', 'Amazon Prime']) expect(counterpartyKey(label)).toBe('amazon prime');
    expect(merchantName('eBay O*13-12787-68146')).toBe('eBay');
    expect(merchantName('AIRBNB * HMS9A2KXCW')).toBe('Airbnb');
    expect(merchantName('LIME*3 RIDES J2FX')).toBe('Lime');
    expect(merchantName('Revolut**1753*')).toBe('Revolut');
    expect(merchantName('MNE*95015933Moneynet_S')).toBe('Moneynet');
    expect(merchantName('UBR* PENDING.UBER.COM')).toBe('Uber');
  });

  it('cuts the card terminal provider in front of the shop', () => {
    expect(merchantName('SumUp *Asia Markt')).toBe('Asia Markt');
    expect(merchantName('Zettle_*honoki')).toBe('honoki');
    expect(merchantName('SQ *SANTAL CAFE PALMA')).toBe('SANTAL CAFE PALMA');
    expect(merchantName('SPC*LPG BIOMARKT')).toBe('LPG BIOMARKT');
    expect(merchantName('UZR*BERTA BLOCK BOULDERHA')).toBe('BERTA BLOCK BOULDERHA');
    expect(counterpartyKey('PSP*neverless.com')).toBe(counterpartyKey('neverless.com'));
    // Nothing usable after the provider: its own name stays.
    expect(merchantName('SumUp *')).toBe('SumUp *');
    expect(merchantName('SumUp')).toBe('SumUp');
  });

  it('leaves PayPal and Klarna in the name: the funding rule recognizes their debits by it', () => {
    expect(counterpartyKey('PAYPAL *SPOTIFY')).toBe('paypal spotify');
    expect(counterpartyKey('PayPal Europe S.a.r.l. et Cie S.C.A')).toContain('paypal');
    expect(counterpartyKey('Klarna')).toBe('klarna');
  });

  it('leaves every other name as it was', () => {
    for (const label of ['Telekom Deutschland GmbH', 'AMAZON PAYMENTS EUROPE S.C.A.', 'Riverty fur Amazon', 'Neverless Labs SL', 'ANTHROPIC* CLAUDE SUB', 'Max Beispiel']) expect(merchantName(label)).toBe(label);
  });
});
