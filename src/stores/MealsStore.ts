import { computed, makeAutoObservable, observable } from 'mobx';
import type { Contact } from '@/lib/contacts/store';
import type { MealBatchKind, MealBatchResult } from '@/lib/meals/batch';
import { incompleteQueue, type IncompleteEntry } from '@/lib/meals/register';
import { isDismissedMeal } from '@/lib/meals/rules';
import type { MealRecord, MealTaxSettings } from '@/lib/meals/types';
import { MealsOutbox, type MealWrite } from './MealsOutbox';

export interface MealsSeed {
  records: MealRecord[];
  contacts: Contact[];
  settings: MealTaxSettings;
  defaultHost: string;
  /** When the server began reading this: what it confirmed from then on is laid over it. */
  readAt: number;
}

/** What a list action does to a receipt on screen, the same as the server does. Null: gone. */
const EDITS: Record<MealBatchKind, (record: MealRecord) => MealRecord | null> = {
  not_meal: (record) => ({ ...record, mealType: 'not_a_meal' }),
  restore: (record) => ({ ...record, mealType: 'business_meal_external' }),
  delete: () => null,
};

/** Whether the action still means anything for a receipt as it is on screen: a second click means nothing. */
const APPLIES: Record<MealBatchKind, (record: MealRecord) => boolean> = {
  not_meal: (record) => record.mealType !== 'not_a_meal',
  restore: (record) => record.mealType === 'not_a_meal',
  delete: () => true,
};

type Change = readonly [rowId: string, record: MealRecord | null];

/**
 * The business meals on the client: the one copy of what the server sent, by
 * record, and everything worked out from it. A record is replaced whole, never
 * changed in place, so a row can tell by its record whether it has to redraw.
 *
 * What is on screen is worked out as in the `ChecksStore`: what the server last
 * said about each receipt, with the list actions still on their way on top of it
 * in order. A refused action just leaves the pile, so its receipts come back as
 * they are by now, in their old place. The pile lives in the `MealsOutbox`, which
 * outlives a visit of the page.
 */
export class MealsStore {
  private byId = observable.map<string, MealRecord>([], { deep: false });
  /** What the server last said about each receipt. */
  private known: Map<string, MealRecord>;
  private outbox: MealsOutbox;
  private readAt: number;
  contacts: Contact[];
  settings: MealTaxSettings;
  defaultHost: string;

  constructor(seed: MealsSeed, outbox = new MealsOutbox()) {
    this.outbox = outbox;
    this.readAt = seed.readAt;
    this.known = new Map(seed.records.map((r) => [r.rowId, r]));
    this.contacts = seed.contacts;
    this.settings = seed.settings;
    this.defaultHost = seed.defaultHost;
    this.absorbConfirmed();
    this.draw();
    makeAutoObservable<MealsStore, 'byId' | 'known' | 'outbox' | 'readAt'>(
      this,
      { byId: false, known: false, outbox: false, readAt: false, contacts: observable.ref, settings: observable.ref, records: computed },
      { autoBind: true },
    );
  }

  get records(): MealRecord[] {
    return [...this.byId.values()];
  }

  /** Receipts marked "Keine Bewirtung" never reach the queue, the register or the year picker. */
  get meals(): MealRecord[] {
    return this.records.filter((r) => !isDismissedMeal(r));
  }

  get dismissed(): MealRecord[] {
    return this.records.filter(isDismissedMeal);
  }

  get queue(): IncompleteEntry[] {
    return incompleteQueue(this.meals);
  }

  /** The list action shows at once; `answered` or `refused` end it. Null when it means nothing for any of the receipts. */
  begin(kind: MealBatchKind, rowIds: string[]): MealWrite | null {
    const applying = rowIds.filter((id) => {
      const record = this.byId.get(id);
      return record !== undefined && APPLIES[kind](record);
    });
    if (applying.length === 0) return null;
    const write = this.outbox.begin(kind, applying);
    this.draw();
    return write;
  }

  /** What the server did, receipt by receipt. One it left alone falls back as the write leaves the pile. */
  answered(write: MealWrite, { done, records, skipped, at }: MealBatchResult): void {
    const saved = new Map(records.map((r) => [r.rowId, r]));
    const gone = skipped.filter((s) => s.reason === 'not_found').map((s) => s.rowId);
    const changes: Change[] = [...done.map((rowId): Change => [rowId, saved.get(rowId) ?? null]), ...gone.map((rowId): Change => [rowId, null])];
    this.settle(write, changes.filter(([rowId, record]) => this.outbox.confirm(rowId, record, at)));
  }

  /** Refused, or no answer at all: this write leaves the pile, and nothing else does. */
  refused(write: MealWrite, who: string | null, message: string): void {
    this.say(write, who, message);
    this.settle(write, []);
  }

  /** What the shell says about a write: alone for a refusal, beside `answered` for one that went through in part. */
  say(write: MealWrite, who: string | null, message: string): void {
    this.outbox.say(write, who, message);
  }

  private settle(write: MealWrite, changes: Change[]): void {
    this.outbox.end(write);
    // A write can end after the page it began on closed: the store on screen by now has to hear of it.
    for (const store of new Set(this.outbox.open ? [this, this.outbox.open] : [this])) store.took(changes);
  }

  private took(changes: Change[]): void {
    for (const [rowId, record] of changes) this.absorb(rowId, record);
    this.draw();
  }

  /** The page opened: what was confirmed between reading this store's seed and now. */
  catchUp(): void {
    this.absorbConfirmed();
    this.draw();
  }

  private absorbConfirmed(): void {
    for (const [rowId, { record, at }] of this.outbox.confirmed) if (at >= this.readAt) this.absorb(rowId, record);
  }

  /** What the server said becomes what is known. A receipt the page no longer has stays out. */
  private absorb(rowId: string, record: MealRecord | null): void {
    if (record === null) this.known.delete(rowId);
    else if (this.known.has(rowId)) this.known.set(rowId, record);
  }

  /** A saved form. An answer older than what the server confirmed since changes nothing. */
  recordSaved(record: MealRecord, at: number): void {
    if (!this.keep(record, at)) return;
    if (record.host.trim()) this.defaultHost = record.host.trim();
    this.draw();
  }

  /** A turned receipt: the same, without a host to remember. */
  recordsSaved(saved: MealRecord[], at: number): void {
    for (const record of saved) this.keep(record, at);
    this.draw();
  }

  private keep(record: MealRecord, at: number): boolean {
    if (!this.known.has(record.rowId) || !this.outbox.confirm(record.rowId, record, at)) return false;
    this.known.set(record.rowId, record);
    return true;
  }

  settingsChanged(settings: MealTaxSettings): void {
    this.settings = settings;
  }

  /** A guest created or corrected in a meal's form. A corrected contact changes how it is printed on existing meals. */
  contactUpserted(contact: Contact): void {
    const known = this.contacts.some((c) => c.id === contact.id);
    this.contacts = (known ? this.contacts.map((c) => (c.id === contact.id ? contact : c)) : [...this.contacts, contact]).sort((a, b) => a.name.localeCompare(b.name, 'de'));
    for (const record of this.known.values()) {
      if (!record.guests.some((g) => g.contactId === contact.id)) continue;
      this.known.set(record.rowId, {
        ...record,
        guests: record.guests.map((g) => (g.contactId === contact.id ? { ...g, name: contact.name, company: contact.companyOrRole } : g)),
      });
    }
    this.draw();
  }

  private shown(known: MealRecord): MealRecord | null {
    let record: MealRecord | null = known;
    for (const write of this.outbox.writes) if (record && write.rowIds.includes(known.rowId)) record = EDITS[write.kind](record);
    return record;
  }

  /** Only a receipt with a write on the pile gets a new object here: every other row keeps its record, and with it stays as drawn. */
  private draw(): void {
    const entries: Array<[string, MealRecord]> = [];
    for (const [id, known] of this.known) {
      const record = this.shown(known);
      if (record) entries.push([id, record]);
    }
    this.byId.replace(entries);
  }
}
