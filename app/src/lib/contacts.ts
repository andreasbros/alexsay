import type { NewContact } from "../api";

interface ContactsManager {
  select: (properties: string[], options: { multiple: boolean }) => Promise<{ name?: string[]; tel?: string[] }[]>;
}

const manager = (): ContactsManager | null => {
  const nav = navigator as Navigator & { contacts?: ContactsManager };
  return nav.contacts && typeof nav.contacts.select === "function" ? nav.contacts : null;
};

/** The Contact Picker API exists on Android Chrome and iOS Safari; desktop browsers import a vCard file instead. */
export const canPickContacts = () => typeof navigator !== "undefined" && manager() !== null;

/** Opens the phone's own contact picker; the user chooses who to share and only names and numbers come across. */
export async function pickContacts(): Promise<NewContact[]> {
  const picker = manager();
  if (!picker) {
    return [];
  }
  const picked = await picker.select(["name", "tel"], { multiple: true });
  return picked.flatMap((entry) => {
    const name = entry.name?.find(Boolean)?.trim() ?? "";
    return (entry.tel ?? []).filter(Boolean).map((phone) => ({ name: name || phone, phone, label: "" }));
  });
}

const LABELS: [RegExp, string][] = [
  [/cell|mobile|iphone/i, "mobile"],
  [/home/i, "home"],
  [/work/i, "work"],
  [/main/i, "main"],
];

/**
 * Names and numbers out of a vCard export (iPhone, Google Contacts, Outlook): FN or N for the name,
 * every TEL with its type as the label. Folded lines are joined first, as RFC 6350 requires.
 */
export function parseVcf(text: string): NewContact[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const cards = unfolded.split(/^BEGIN:VCARD\s*$/im).slice(1);
  return cards.flatMap((card) => {
    const lines = card.split(/\r?\n/).filter((line) => line && !/^END:VCARD/i.test(line));
    let name = "";
    const phones: { phone: string; label: string }[] = [];
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon === -1) {
        continue;
      }
      const head = line.slice(0, colon);
      const value = unescapeValue(line.slice(colon + 1));
      const property = head
        .replace(/^item\d+\./i, "")
        .split(";")[0]
        ?.toUpperCase();
      if (property === "FN" && value.trim()) {
        name = value.trim();
      } else if (property === "N" && !name) {
        const [last = "", first = "", middle = ""] = value.split(";");
        name = [first, middle, last].filter(Boolean).join(" ").trim();
      } else if (property === "TEL") {
        const phone = value.replace(/^tel:/i, "").trim();
        if (phone) {
          phones.push({ phone, label: labelOf(head) });
        }
      }
    }
    return phones.map((entry) => ({ name: name || entry.phone, ...entry }));
  });
}

function labelOf(head: string): string {
  const types = head.split(";").slice(1).join(";");
  return LABELS.find(([pattern]) => pattern.test(types))?.[1] ?? "";
}

const unescapeValue = (value: string) => value.replace(/\\([,;\\])/g, "$1").replace(/\\n/gi, " ");
