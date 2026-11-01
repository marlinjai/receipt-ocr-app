import { computed, makeAutoObservable, observable } from 'mobx';
import type { Contact } from '@/lib/contacts/store';
import { incompleteQueue, type IncompleteEntry } from '@/lib/meals/register';
import { isDismissedMeal } from '@/lib/meals/rules';
import type { MealRecord, MealTaxSettings } from '@/lib/meals/types';

export interface MealsSeed {
  records: MealRecord[];
  contacts: Contact[];
  settings: MealTaxSettings;
  defaultHost: string;
}

/**
 * The business meals on the client: the one copy of what the server sent, by
 * record, and everything worked out from it. A record is replaced whole, never
 * changed in place, so a row can tell by its record whether it has to redraw.
 */
export class MealsStore {
  private byId = observable.map<string, MealRecord>([], { deep: false });
  contacts: Contact[];
  settings: MealTaxSettings;
  defaultHost: string;

  constructor(seed: MealsSeed) {
    this.byId.replace(seed.records.map((r) => [r.rowId, r]));
    this.contacts = seed.contacts;
    this.settings = seed.settings;
    this.defaultHost = seed.defaultHost;
    makeAutoObservable<MealsStore, 'byId'>(this, { byId: false, contacts: observable.ref, settings: observable.ref, records: computed }, { autoBind: true });
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

  /** A record the page no longer has stays out: a save can arrive after its delete. */
  recordSaved(record: MealRecord): void {
    if (this.byId.has(record.rowId)) this.byId.set(record.rowId, record);
    if (record.host.trim()) this.defaultHost = record.host.trim();
  }

  recordsSaved(saved: MealRecord[]): void {
    for (const record of saved) if (this.byId.has(record.rowId)) this.byId.set(record.rowId, record);
  }

  recordsRemoved(rowIds: string[]): void {
    for (const rowId of rowIds) this.byId.delete(rowId);
  }

  settingsChanged(settings: MealTaxSettings): void {
    this.settings = settings;
  }

  /** A guest created or corrected in a meal's form. A corrected contact changes how it is printed on existing meals. */
  contactUpserted(contact: Contact): void {
    const known = this.contacts.some((c) => c.id === contact.id);
    this.contacts = (known ? this.contacts.map((c) => (c.id === contact.id ? contact : c)) : [...this.contacts, contact]).sort((a, b) => a.name.localeCompare(b.name, 'de'));
    for (const record of this.records) {
      if (!record.guests.some((g) => g.contactId === contact.id)) continue;
      this.byId.set(record.rowId, {
        ...record,
        guests: record.guests.map((g) => (g.contactId === contact.id ? { ...g, name: contact.name, company: contact.companyOrRole } : g)),
      });
    }
  }
}
