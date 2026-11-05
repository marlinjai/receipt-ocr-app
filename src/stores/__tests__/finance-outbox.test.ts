import { describe, expect, it, vi } from 'vitest';
import { AppStore } from '../AppStore';
import { FinanceOutbox } from '../FinanceOutbox';

/** The refusals of finance writes answered after the finance page closed. */

describe('FinanceOutbox', () => {
  it('keeps a refusal under its own key until it is closed', () => {
    const outbox = new FinanceOutbox();
    outbox.say('Finanzen', 'Abgelehnt.');
    outbox.say('Finanzen, Laptop', 'Diese Anlage gibt es nicht mehr.');
    const said = [...outbox.refusals.values()];
    expect(said.map((r) => r.message)).toEqual(['Abgelehnt.', 'Diese Anlage gibt es nicht mehr.']);
    expect(new Set(said.map((r) => r.key)).size).toBe(2);
    outbox.clear(said[0].key);
    expect([...outbox.refusals.values()].map((r) => r.who)).toEqual(['Finanzen, Laptop']);
  });

  it('on leaving the company hands over what stands and what comes later, and keeps it again after staying', () => {
    const outbox = new FinanceOutbox();
    outbox.say('Finanzen', 'vorher');
    const send = vi.fn();
    outbox.leave(send);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ who: 'Finanzen', message: 'vorher' }));
    expect(outbox.refusals.size).toBe(0);
    outbox.say('Finanzen', 'danach');
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'danach' }));
    expect(outbox.refusals.size).toBe(0);
    outbox.stay();
    outbox.say('Finanzen', 'wieder hier');
    expect(send).toHaveBeenCalledTimes(2);
    expect(outbox.refusals.size).toBe(1);
  });
});

describe('the AppStore and finance refusals', () => {
  it('shows them in the shell, closes them there and hands them on when the company is left', () => {
    const app = new AppStore();
    app.financeOutbox.say('Finanzen', 'Abgelehnt.');
    const [refusal] = app.looseRefusals;
    expect(refusal).toMatchObject({ who: 'Finanzen', message: 'Abgelehnt.' });
    app.closeRefusal(refusal.key);
    expect(app.looseRefusals).toEqual([]);

    app.financeOutbox.say('Finanzen', 'noch offen');
    const send = vi.fn();
    app.leave(send);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ message: 'noch offen' }));
    expect(app.looseRefusals).toEqual([]);
  });
});
