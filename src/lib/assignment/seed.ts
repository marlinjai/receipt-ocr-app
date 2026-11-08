/**
 * The owner's own statements, seeded as freetext rules of Whiz-Art Media (plan
 * docs/plans/2026-11-07-learned-assignment.md, decision 5). They are his
 * statements; the mechanism is the same for everyone, and a person edits or
 * deletes them on the rules page like any statement. The replay (decision 6)
 * counts them as stated from the start; scripts/seed-assignment-statements.ts
 * writes them, idempotently, once.
 */

/** Whiz-Art Media, the owner's company workspace. */
export const OWNER_WORKSPACE_ID = '019fa320-8e10-7978-b0a6-0b0d3bad83c3';

export interface SeedStatement {
  /** Stable, so the replay names the same statement the rules page will hold. */
  key: string;
  text: string;
  /** The assignment the statement names, where exactly one. */
  zuordnung: string | null;
}

export const OWNER_STATEMENTS: readonly SeedStatement[] = [
  { key: 'business-kinds', text: 'Software, Cloud-Dienste, Technik und Ausstattung sowie Geschäftsreisen sind geschäftlich.', zuordnung: 'Geschäftlich' },
  { key: 'studies-ended', text: 'Mein Studium endete im April/Mai 2026: Ab Mai 2026 gibt es keine Ausgaben für die Universität mehr, außer es beginnt ein neuer Master oder eine Promotion.', zuordnung: null },
  { key: 'private-kinds', text: 'Drogerie, Lebensmittel und Streaming für mich selbst sind privat.', zuordnung: 'Privat' },
  { key: 'mixed-vendors', text: 'Amazon, Apple und MediaMarkt sind gemischt: Dort entscheidet, was gekauft wurde, nie der Anbieter.', zuordnung: null },
  { key: 'restaurants', text: 'Restaurants sind privat, außer die Mahlzeit ist als Bewirtung mit Anlass erfasst.', zuordnung: 'Privat' },
];
