import { describe, expect, it } from 'vitest';
import { bankMessage, preselectInstitution, returnMessage } from '../messages';

describe('bank messages', () => {
  it('turns codes into German sentences, the most specific part first', () => {
    expect(bankMessage('bank_error:rate_limited')).toContain('nächste Lauf');
    expect(bankMessage('aspsp_not_offered')).toContain('Datei-Import');
    expect(bankMessage('parse_unreadable_row')).toContain('nicht lesen');
    expect(bankMessage('weird<code>')).toBe('Unbekannter Fehler (weirdcode).');
  });

  it('a list-fed account: PayPal can be connected, Klarna cannot; a mismatched institution says what fits', () => {
    const klarna = bankMessage('account_source_unsupported');
    expect(klarna).toContain('Klarna');
    expect(klarna).toContain('nicht die Käufe auf Rechnung oder in Raten');
    expect(klarna).toContain('PayPal-Konto lässt sich dagegen live verbinden');
    expect(bankMessage('institution_mismatch')).toContain('nur mit PayPal');
    expect(bankMessage('import_failed:format_mismatch')).toContain('PayPal-Liste und der Live-Verbindung zu PayPal');
  });

  it('reads the return from the bank', () => {
    expect(returnMessage('verbunden')?.ok).toBe(true);
    expect(returnMessage('konto_waehlen')?.ok).toBe(true);
    expect(returnMessage('fehler:state_invalid')).toMatchObject({ ok: false });
    expect(returnMessage('anything')).toBeNull();
    expect(returnMessage(null)).toBeNull();
  });

  it('preselects the institution named in the account label, the longest name winning', () => {
    const list = [{ name: 'N26' }, { name: 'Beispielbank' }, { name: 'Beispielbank Plus' }, { name: 'AB' }];
    expect(preselectInstitution('N26 privat', list)?.name).toBe('N26');
    expect(preselectInstitution('Konto bei Beispielbank Plus', list)?.name).toBe('Beispielbank Plus');
    expect(preselectInstitution('Tabelle', list)).toBeNull();
  });
});
