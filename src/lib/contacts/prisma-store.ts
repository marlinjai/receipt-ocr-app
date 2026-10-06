import 'server-only';
import type { PrismaClient } from '@prisma/client';
import {
  ContactError,
  contactIdentityKey,
  normalizeContactInput,
  type Contact,
  type ContactInput,
  type ContactStore,
} from './store';

type ContactRow = {
  id: string;
  name: string;
  companyOrRole: string;
  note: string | null;
  archivedAt: Date | null;
};

function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    name: row.name,
    companyOrRole: row.companyOrRole,
    note: row.note,
    archived: row.archivedAt !== null,
  };
}

/**
 * The contact list stored in this app's own `contacts` table.
 *
 * An instance is bound to ONE workspace at construction. Every query carries
 * that workspace id in its WHERE clause, so an id from another workspace
 * behaves exactly like an id that does not exist.
 */
export class PrismaContactStore implements ContactStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly workspaceId: string,
    /** Stamped on create only (same rule as the other workspace models). */
    private readonly tenantId: string | null,
  ) {}

  async list(options: { includeArchived?: boolean } = {}): Promise<Contact[]> {
    const rows = await this.db.contact.findMany({
      where: {
        authWorkspaceId: this.workspaceId,
        ...(options.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ name: 'asc' }, { companyOrRole: 'asc' }],
    });
    return rows.map(toContact);
  }

  async getMany(ids: string[]): Promise<Contact[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const rows = await this.db.contact.findMany({
      where: { authWorkspaceId: this.workspaceId, id: { in: unique } },
    });
    return rows.map(toContact);
  }

  /** Case-insensitive duplicate lookup; the unique index alone is case-sensitive. */
  private async findSame(name: string, companyOrRole: string, exceptId?: string): Promise<Contact | null> {
    const candidates = await this.db.contact.findMany({
      where: {
        authWorkspaceId: this.workspaceId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
    });
    const key = contactIdentityKey(name, companyOrRole);
    const hit = candidates.find((c) => contactIdentityKey(c.name, c.companyOrRole) === key);
    return hit ? toContact(hit) : null;
  }

  private async requireOwn(id: string): Promise<ContactRow> {
    const row = await this.db.contact.findFirst({
      where: { id, authWorkspaceId: this.workspaceId },
    });
    if (!row) throw new ContactError('not_found');
    return row;
  }

  async create(input: ContactInput): Promise<Contact> {
    const data = normalizeContactInput(input);
    const existing = await this.findSame(data.name, data.companyOrRole);
    if (existing) throw new ContactError('duplicate', existing);
    try {
      const row = await this.db.contact.create({
        data: { ...data, authWorkspaceId: this.workspaceId, authTenantId: this.tenantId },
      });
      return toContact(row);
    } catch (e) {
      // Two creates racing past the lookup: the unique index decides.
      if ((e as { code?: string }).code === 'P2002') {
        const winner = await this.findSame(data.name, data.companyOrRole);
        throw new ContactError('duplicate', winner ?? undefined);
      }
      throw e;
    }
  }

  async update(id: string, input: ContactInput): Promise<Contact> {
    const data = normalizeContactInput(input);
    await this.requireOwn(id);
    const existing = await this.findSame(data.name, data.companyOrRole, id);
    if (existing) throw new ContactError('duplicate', existing);
    try {
      // The correction and the printed copies on existing meals change together.
      const [row] = await this.db.$transaction([
        this.db.contact.update({ where: { id }, data }),
        this.db.mealGuest.updateMany({
          where: { contactId: id, authWorkspaceId: this.workspaceId },
          data: { displayName: data.name, displayCompany: data.companyOrRole },
        }),
      ]);
      return toContact(row);
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ContactError('duplicate');
      throw e;
    }
  }

  async archive(id: string): Promise<Contact> {
    const row = await this.requireOwn(id);
    if (row.archivedAt) return toContact(row);
    return toContact(await this.db.contact.update({ where: { id }, data: { archivedAt: new Date() } }));
  }

  async restore(id: string): Promise<Contact> {
    const row = await this.requireOwn(id);
    if (!row.archivedAt) return toContact(row);
    return toContact(await this.db.contact.update({ where: { id }, data: { archivedAt: null } }));
  }
}
