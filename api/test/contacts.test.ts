import { beforeEach, describe, expect, it } from "vitest";
import { APP, addUser, call, json, resetDb, signIn } from "./helpers";

interface Contact {
  id: string;
  name: string;
  phone: string;
  label: string;
  favourite: boolean;
}
interface Page {
  contacts: Contact[];
  total: number;
  page: number;
  page_size: number;
}

const list = async (cookie: string, query = "") =>
  (await (await call(`${APP}/api/contacts${query}`, {}, cookie)).json()) as Page;
const tool = async (cookie: string, name: string, args: Record<string, unknown>) =>
  (
    (await (await json(`${APP}/api/tools/call`, "POST", { name, arguments: args }, cookie)).json()) as {
      output: unknown;
    }
  ).output;

describe("contacts", () => {
  let maria: string;

  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
    maria = await signIn("maria", "maria-pass");
  });

  it("stores a typed contact with the number normalised", async () => {
    const res = await json(
      `${APP}/api/contacts`,
      "POST",
      { name: "Mum", phone: "07700 900123", label: "mobile" },
      maria,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "Mum", phone: "+447700900123", label: "mobile", favourite: false });
    const bad = await json(`${APP}/api/contacts`, "POST", { name: "Nobody", phone: "123" }, maria);
    expect(bad.status).toBe(400);
  });

  it("imports a phone book, counting new, renamed and unusable entries", async () => {
    const first = await json(
      `${APP}/api/contacts/import`,
      "POST",
      {
        contacts: [
          { name: "Mum", phone: "07700 900123", label: "mobile" },
          { name: "Dad", phone: "+44 7700 900124", label: "" },
          { name: "Broken", phone: "n/a", label: "" },
        ],
      },
      maria,
    );
    expect(await first.json()).toEqual({ imported: 2, updated: 0, skipped: 1 });
    const second = await json(
      `${APP}/api/contacts/import`,
      "POST",
      { contacts: [{ name: "Mother", phone: "+447700900123", label: "" }] },
      maria,
    );
    expect(await second.json()).toEqual({ imported: 0, updated: 1, skipped: 0 });
    const page = await list(maria);
    expect(page.total).toBe(2);
    // The rename stuck and the blank label did not wipe the kept one
    expect(page.contacts.find((c) => c.phone === "+447700900123")).toMatchObject({ name: "Mother", label: "mobile" });
  });

  it("pages favourites first and searches by name or digits", async () => {
    const names = Array.from({ length: 60 }, (_, i) => `Person ${String(i).padStart(2, "0")}`);
    await json(
      `${APP}/api/contacts/import`,
      "POST",
      { contacts: names.map((name, i) => ({ name, phone: `+4477009${String(i).padStart(5, "0")}`, label: "" })) },
      maria,
    );
    const page1 = await list(maria);
    expect(page1).toMatchObject({ total: 60, page: 1, page_size: 50 });
    expect(page1.contacts).toHaveLength(50);
    const page2 = await list(maria, "?page=2");
    expect(page2.contacts).toHaveLength(10);
    const last = page2.contacts[9];
    expect(last).toBeDefined();
    const starred = await json(`${APP}/api/contacts/${last?.id}`, "PATCH", { favourite: true }, maria);
    expect(starred.status).toBe(204);
    expect((await list(maria)).contacts[0]).toMatchObject({ name: "Person 59", favourite: true });
    expect((await list(maria, "?favourites=1")).total).toBe(1);
    expect((await list(maria, "?q=person%2007")).contacts.map((c) => c.name)).toEqual(["Person 07"]);
    expect((await list(maria, "?q=900042")).contacts.map((c) => c.name)).toEqual(["Person 42"]);
  });

  it("shows one contact with its history and deletes it", async () => {
    const created = (await (
      await json(`${APP}/api/contacts`, "POST", { name: "Mum", phone: "07700900123" }, maria)
    ).json()) as Contact;
    const detail = await call(`${APP}/api/contacts/${created.id}`, {}, maria);
    expect(await detail.json()).toMatchObject({ name: "Mum", messages: [], calls: [] });
    expect((await call(`${APP}/api/contacts/${created.id}`, { method: "DELETE" }, maria)).status).toBe(204);
    expect((await call(`${APP}/api/contacts/${created.id}`, {}, maria)).status).toBe(404);
  });

  it("keeps each user's phone book to themselves", async () => {
    await addUser("tom", "tom-pass-123", "user");
    const tom = await signIn("tom", "tom-pass-123");
    const created = (await (
      await json(`${APP}/api/contacts`, "POST", { name: "Mum", phone: "07700900123" }, maria)
    ).json()) as Contact;
    expect((await list(tom)).total).toBe(0);
    expect((await call(`${APP}/api/contacts/${created.id}`, {}, tom)).status).toBe(404);
  });

  it("lets the assistant find, page and star contacts", async () => {
    await json(
      `${APP}/api/contacts/import`,
      "POST",
      {
        contacts: [
          { name: "Mum", phone: "07700900123", label: "mobile" },
          { name: "Mum", phone: "02079460958", label: "home" },
          { name: "John Smith", phone: "07700900200", label: "" },
        ],
      },
      maria,
    );
    const found = (await tool(maria, "find_contact", { query: "mum" })) as { name: string; label: string }[];
    expect(found.map((c) => c.label).sort()).toEqual(["home", "mobile"]);
    expect(await tool(maria, "favourite_contact", { name: "John", favourite: true })).toEqual({
      ok: true,
      contact: "John Smith",
      favourite: true,
    });
    const listed = (await tool(maria, "list_contacts", { favourites_only: true })) as { contacts: { name: string }[] };
    expect(listed.contacts.map((c) => c.name)).toEqual(["John Smith"]);
    expect(await tool(maria, "favourite_contact", { name: "Nobody", favourite: true })).toEqual({
      error: 'no contact called "Nobody"',
    });
  });
});
