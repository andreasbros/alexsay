import { contacts } from "./db";
import { normalisePhone, searchName } from "./phone";
import type { ContactRow } from "./types";

export interface Recipient {
  phone: string;
  contact: ContactRow | null;
}

export interface RecipientRef {
  contact_id?: string;
  name?: string;
  number?: string;
}

export type Option = Pick<ContactRow, "id" | "name" | "label" | "phone">;

export type Resolved = ({ ok: true } & Recipient) | { ok: false; error: string; options?: Option[] };

const MATCH_LIMIT = 10;

/**
 * Turns "Mum", a contact id or a number as spoken into one phone number. A name that fits several
 * people comes back as a question with the options, never a guess.
 */
export async function resolveRecipient(
  db: D1Database,
  home: string,
  countryCode: string,
  ref: RecipientRef,
): Promise<Resolved> {
  if (ref.contact_id) {
    const contact = await contacts.get(db, home, ref.contact_id);
    return contact ? { ok: true, phone: contact.phone, contact } : { ok: false, error: "no such contact" };
  }
  if (ref.number) {
    const phone = normalisePhone(ref.number, countryCode);
    if (!phone) {
      return { ok: false, error: `"${ref.number}" is not a phone number` };
    }
    return { ok: true, phone, contact: await contacts.byPhone(db, home, phone) };
  }
  if (ref.name) {
    return byName(db, home, ref.name);
  }
  return { ok: false, error: "give a contact_id, a name or a number" };
}

async function byName(db: D1Database, home: string, name: string): Promise<Resolved> {
  const { rows } = await contacts.list(db, home, { query: name, page: 1, pageSize: MATCH_LIMIT });
  if (rows.length === 0) {
    return { ok: false, error: `no contact called "${name}"` };
  }
  const exact = rows.filter((row) => row.search_name === searchName(name));
  const pool = exact.length > 0 ? exact : rows;
  const people = new Set(pool.map((row) => row.name));
  if (people.size > 1) {
    return { ok: false, error: `several contacts match "${name}"; ask which one`, options: pool.map(option) };
  }
  const contact = [...pool].sort(preferred)[0];
  return contact ? { ok: true, phone: contact.phone, contact } : { ok: false, error: `no contact called "${name}"` };
}

/** One person, several numbers: the mobile, else whichever the user reached most recently. */
function preferred(a: ContactRow, b: ContactRow): number {
  const mobile = (row: ContactRow) => (/mobile|cell|iphone/i.test(row.label) ? 1 : 0);
  const reached = (row: ContactRow) => Math.max(row.last_called_at ?? 0, row.last_messaged_at ?? 0);
  return mobile(b) - mobile(a) || reached(b) - reached(a) || b.favourite - a.favourite;
}

export const option = (row: ContactRow): Option => ({ id: row.id, name: row.name, label: row.label, phone: row.phone });
