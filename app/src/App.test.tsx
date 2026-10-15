import { Theme } from "@radix-ui/themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { Device } from "./api";

const device: Device = {
  id: "7d1d6e2e-7c7b-4f6a-9d0a-1d2e3f4a5b6c",
  name: "Kitchen",
  owner: "maria",
  created_at: 0,
  claimed_at: 0,
  last_seen_at: Date.now(),
  firmware: "0.1.0",
  online: true,
};

function mockApi(routes: Record<string, () => Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => routes[path]?.() ?? new Response("{}", { status: 404 })),
  );
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status });

function renderApp(path = "/") {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Theme>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </Theme>
    </QueryClientProvider>,
  );
}

/** Home sections fold closed until opened; this opens one by its title. */
async function openSection(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name, expanded: false }));
}

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("asks for credentials without a session", async () => {
    mockApi({ "/api/session/me": json({ error: "unauthenticated" }, 401) });
    renderApp();
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Create an account" })).toBeDefined();
  });

  it("shows a wrong-password message", async () => {
    mockApi({
      "/api/session/me": json({ error: "unauthenticated" }, 401),
      "/api/session/login": json({ error: "invalid" }, 401),
    });
    renderApp();
    fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "andreas" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Wrong username or password.")).toBeDefined();
  });

  it("offers registration with a password check", async () => {
    mockApi({ "/api/session/me": json({ error: "unauthenticated" }, 401) });
    renderApp("/register");
    fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "maria" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "battery staple" } });
    fireEvent.change(screen.getByLabelText("Repeat password"), { target: { value: "battery stapler" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("The passwords differ.")).toBeDefined();
  });

  it("says why an account could not be created, whatever the reason", async () => {
    const register = async (code: string) => {
      cleanup();
      mockApi({
        "/api/session/me": json({ error: "unauthenticated" }, 401),
        "/api/session/register": json({ error: code }, 429),
      });
      renderApp("/register");
      fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "maria" } });
      fireEvent.change(screen.getByLabelText("Password"), { target: { value: "battery staple" } });
      fireEvent.change(screen.getByLabelText("Repeat password"), { target: { value: "battery staple" } });
      fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    };
    await register("too_many");
    expect(await screen.findByText("Too many new accounts from this address. Try again in an hour.")).toBeDefined();
    await register("something_new");
    expect(await screen.findByText("The account could not be created (something_new).")).toBeDefined();
  });

  it("lists the signed-in user's speakers", async () => {
    mockApi({
      "/api/session/me": json({ username: "maria", role: "user" }),
      "/api/devices": json([device]),
    });
    renderApp();
    await openSection("Devices");
    expect(await screen.findByText("Kitchen")).toBeDefined();
    expect(screen.getByText("online")).toBeDefined();
    const tabs = screen.getAllByRole("navigation").flatMap((nav) => within(nav).queryAllByRole("link"));
    expect([...new Set(tabs.map((link) => link.getAttribute("href")))]).toEqual([
      "/",
      "/assistant",
      "/messages",
      "/memory",
      "/skills",
    ]);
  });

  it("offers to drop in on an online speaker that takes it, after asking, from a browser that can", async () => {
    vi.stubGlobal("AudioContext", class {});
    vi.stubGlobal("WebSocket", class {});
    const getUserMedia = vi.fn(async () => {
      throw new Error("no microphone here");
    });
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
    const older = { ...device, id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", name: "Hall", firmware: "0.1.3" };
    const offline = { ...device, id: "2a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", name: "Shed", online: false };
    mockApi({
      "/api/session/me": json({ username: "maria", role: "user", home: "maria", homeRole: "user" }),
      "/api/devices": json([{ ...device, firmware: "0.1.4" }, older, offline]),
      "/api/connections": json([]),
    });
    renderApp();
    await openSection("Devices");
    expect(await screen.findByText("Kitchen")).toBeDefined();
    // The button sits before the name, and only where it would work
    const row = screen.getByRole("row", { name: /Kitchen/ });
    const button = within(row).getByRole("button", { name: "Drop in on Kitchen" });
    expect(row.textContent?.indexOf("Kitchen")).toBeGreaterThan(-1);
    expect(within(row).getAllByRole("button")[0]).toBe(button);
    expect(screen.queryByRole("button", { name: "Drop in on Hall" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Drop in on Shed" })).toBeNull();

    fireEvent.click(button);
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Drop in on Kitchen?")).toBeDefined();
    fireEvent.click(within(confirm).getByRole("button", { name: "Drop in" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Drop in on Kitchen")).toBeDefined();
    expect(await within(dialog).findByText(/Could not start\. no microphone here/)).toBeDefined();
    expect(getUserMedia).toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows what came in under Messages, marks it read and offers to reply or call back", async () => {
    const read: unknown[] = [];
    const routes: Record<string, () => Response> = {
      "/api/session/me": json({ username: "maria", role: "user", home: "maria", homeRole: "user" }),
      "/api/notifications": json({
        unread: 1,
        notifications: [
          {
            id: "n1",
            at: Date.now() - 60_000,
            kind: "note",
            phone: "+447700900123",
            contact_id: "c1",
            contact: "Mum",
            title: "Message from Mum",
            body: "Dinner is at seven",
            ref: null,
            read_at: null,
          },
          {
            id: "n2",
            at: Date.now() - 3_600_000,
            kind: "call",
            phone: "+447700900777",
            contact_id: null,
            contact: null,
            title: "Missed call from +44 7700 900 777",
            body: "",
            ref: null,
            read_at: Date.now(),
          },
        ],
      }),
      "/api/messages?limit=100": json([
        {
          id: "m1",
          at: Date.now(),
          channel: "sms",
          direction: "in",
          phone: "+447700900123",
          contact_id: "c1",
          contact: "Mum",
          body: "Dinner at 7?",
          status: "received",
        },
      ]),
      "/api/twilio/calls?limit=50": json([
        {
          id: "k1",
          at: Date.now(),
          direction: "in",
          kind: "conference",
          role: "guest",
          phone: "+447700900123",
          contact: "Mum",
          status: "no-answer",
          detail: null,
        },
      ]),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        if (path === "/api/notifications/read") {
          read.push(JSON.parse(String(init?.body ?? "{}")));
          return json({ marked: 1 })();
        }
        return routes[path]?.() ?? new Response("{}", { status: 404 });
      }),
    );
    renderApp("/messages");
    expect(await screen.findByText("Message from Mum")).toBeDefined();
    expect(screen.getByText("Dinner is at seven")).toBeDefined();
    expect(screen.getByText("Missed call from +44 7700 900 777")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Reply" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Call back" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    await vi.waitFor(() => expect(read).toEqual([{ ids: ["n1"] }]));
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await vi.waitFor(() => expect(read).toEqual([{ ids: ["n1"] }, {}]));

    // Radix doubles each tab's label (a hidden bold copy keeps the width), so the name is matched loosely
    const tab = (name: string) => {
      const trigger = screen.getByRole("tab", { name: new RegExp(`^${name}`) });
      fireEvent.mouseDown(trigger);
      fireEvent.click(trigger);
    };
    tab("Calls");
    expect(await screen.findByText("Missed")).toBeDefined();
    tab("SMS");
    expect(await screen.findByText("Dinner at 7?")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Reply to Mum")).toBeDefined();
  });

  it("needs a name as well as the UUID to add a speaker", async () => {
    mockApi({
      "/api/session/me": json({ username: "maria", role: "user", home: "maria", homeRole: "admin" }),
      "/api/devices": json([]),
      "/api/connections": json([]),
    });
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Add device" }));
    const dialog = await screen.findByRole("dialog");
    const add = within(dialog).getByRole("button", { name: "Add" });
    fireEvent.change(within(dialog).getByLabelText("UUID"), { target: { value: device.id } });
    expect(add.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Kitchen" } });
    expect(add.hasAttribute("disabled")).toBe(false);
  });

  it("keeps the Add device dialog open when the home finishes loading", async () => {
    let homeArrives: (response: Response) => void = () => undefined;
    const routes: Record<string, () => Response> = {
      "/api/session/me": json({ username: "maria", role: "user", home: "maria", homeRole: "admin" }),
      "/api/devices": json([]),
      "/api/connections": json([]),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) =>
        path === "/api/home"
          ? new Promise<Response>((resolve) => {
              homeArrives = resolve;
            })
          : (routes[path]?.() ?? new Response("{}", { status: 404 })),
      ),
    );
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Add device" }));
    expect(await screen.findByRole("dialog")).toBeDefined();
    homeArrives(
      json({
        id: "maria",
        name: "Flat 4",
        role: "admin",
        creator: true,
        can_invite: false,
        members: [],
        invites: [],
      })(),
    );
    // The open dialog hides the page underneath from the accessibility tree
    expect(await screen.findByRole("heading", { name: "Flat 4", hidden: true })).toBeDefined();
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("puts the speakers after the name and the connections last on the Home page", async () => {
    mockApi({
      "/api/session/me": json({ username: "maria", role: "user", home: "maria", homeRole: "admin" }),
      "/api/home": json({
        id: "maria",
        name: "Flat 4",
        role: "admin",
        creator: true,
        can_invite: false,
        members: [],
        invites: [],
      }),
      "/api/devices": json([device]),
      "/api/connections": json([]),
    });
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    renderApp("/connections");
    await openSection("Devices");
    expect(await screen.findByText("Kitchen")).toBeDefined();
    expect(scrolled).toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Flat 4" })).toBeDefined();
    const order = screen.getAllByRole("heading").map((h) => h.textContent);
    const at = (name: string) => order.indexOf(name);
    expect(at("Devices")).toBeLessThan(at("People"));
    expect(at("People")).toBeLessThan(at("Connections"));
    expect(at("Connections")).toBeLessThan(at("OpenAI"));
  });

  it("explains how to get each provider's keys", async () => {
    mockApi({
      "/api/session/me": json({ username: "maria", role: "user" }),
      "/api/connections": json([]),
    });
    renderApp("/");
    for (const provider of ["OpenAI", "Lightwave", "Twilio"]) {
      await openSection(provider);
    }
    const help = await screen.findAllByRole("button", { name: "Help" });
    expect(help).toHaveLength(3);
    fireEvent.click(help[0] as HTMLElement);
    expect(await screen.findByRole("heading", { name: "Get an OpenAI API key" })).toBeDefined();
    expect(screen.getByText(/Create new secret key/)).toBeDefined();
  });

  it("imports a vCard into the phone book under Memory", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path === "/api/session/me") {
          return new Response(JSON.stringify({ username: "maria", role: "user" }), { status: 200 });
        }
        if (path === "/api/contacts/import") {
          return new Response(JSON.stringify({ imported: 1, updated: 0, skipped: 0 }), { status: 200 });
        }
        if (path.startsWith("/api/contacts")) {
          const contacts = calls.some((c) => c.startsWith("POST /api/contacts/import"))
            ? [
                {
                  id: "c1",
                  name: "Mum",
                  phone: "+447700900123",
                  label: "mobile",
                  favourite: false,
                  last_called_at: null,
                  last_messaged_at: null,
                  updated_at: 0,
                },
              ]
            : [];
          return new Response(JSON.stringify({ contacts, total: contacts.length, page: 1, page_size: 50 }), {
            status: 200,
          });
        }
        return new Response("{}", { status: 404 });
      }),
    );
    renderApp("/memory?tab=contacts");
    expect(await screen.findByText(/No contacts yet/)).toBeDefined();
    const file = new File(["BEGIN:VCARD\nFN:Mum\nTEL;type=CELL:07700 900123\nEND:VCARD\n"], "mum.vcf", {
      type: "text/vcard",
    });
    fireEvent.change(screen.getByLabelText("vCard file"), { target: { files: [file] } });
    expect(await screen.findByText(/Imported 1, updated 0\./)).toBeDefined();
    expect(await screen.findByText("+447700900123")).toBeDefined();
    expect(calls).toContain("POST /api/contacts/import");
  });
  it("lists skills and the alarms coming up, with their speaker and switch", async () => {
    mockApi({
      "/api/session/me": json({ username: "maria", role: "user" }),
      "/api/skills": json([{ id: "alarms", name: "Alarms", description: "Alarms and timers", enabled: true }]),
      "/api/alarms": json({
        alarms: [
          {
            id: "a1",
            kind: "alarm",
            label: "gym",
            message: "",
            enabled: true,
            next_at: 1,
            when: "Thu 15 Oct, 07:00",
            repeat: "weekdays at 07:00",
            snoozed: false,
            device_id: device.id,
            speaker: "Kitchen",
          },
        ],
        recent: [
          {
            alarm_id: "a0",
            kind: "timer",
            label: "pasta",
            event: "missed",
            at: 1,
            when: "Wed 14 Oct, 18:00",
            speaker: "Kitchen",
            detail: "",
          },
        ],
        speakers: [{ id: device.id, name: "Kitchen" }],
        timezone: "Europe/London",
      }),
    });
    renderApp("/skills");
    expect(await screen.findByText("Thu 15 Oct, 07:00")).toBeDefined();
    expect(screen.getByText("Gym")).toBeDefined();
    expect(screen.getByText("weekdays at 07:00")).toBeDefined();
    expect(screen.getByRole("switch", { name: "Gym on" })).toBeDefined();
    expect(screen.getByText("Pasta")).toBeDefined();
    expect(screen.getByText("missed")).toBeDefined();
  });

  it("signs in with an emailed code from the Email tab when the server offers it", async () => {
    mockApi({
      "/api/session/me": json({ error: "unauthenticated" }, 401),
      "/api/session/config": json({ email_login: true, registration: true, captcha: null }),
      "/api/session/email/start": json({ sent: true }),
      "/api/session/email/verify": json({ username: "sam", role: "user", home: "sam", homeRole: "admin" }),
      "/api/devices": json([]),
    });
    renderApp();
    expect(await screen.findByRole("tab", { name: /Password/ })).toBeDefined();
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "sam@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    expect(await screen.findByText("Check your inbox.")).toBeDefined();
    fireEvent.change(await screen.findByLabelText("Code"), { target: { value: "12a3456" } });
    expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe("123456");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await openSection("Devices");
    expect(await screen.findByText(/No speakers yet/)).toBeDefined();
  });

  it("waits for the human check before sending a code when the server asks for one", async () => {
    mockApi({
      "/api/session/me": json({ error: "unauthenticated" }, 401),
      "/api/session/config": json({ email_login: true, registration: true, captcha: "0x4AAAsite" }),
    });
    renderApp();
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "sam@example.com" } });
    expect((screen.getByRole("button", { name: "Email me a code" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("waits for the human check on the password form and on registration too", async () => {
    mockApi({
      "/api/session/me": json({ error: "unauthenticated" }, 401),
      "/api/session/config": json({ email_login: false, registration: true, captcha: "0x4AAAsite" }),
    });
    renderApp();
    fireEvent.change(await screen.findByLabelText("Username"), { target: { value: "maria" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "maria-pass" } });
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    renderApp("/register");
    await screen.findByLabelText("Repeat password");
    expect((screen.getByRole("button", { name: "Create account" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers only the email way of creating an account when email sign-in is on", async () => {
    mockApi({
      "/api/session/me": json({ error: "unauthenticated" }, 401),
      "/api/session/config": json({ email_login: true, registration: true, captcha: null }),
    });
    renderApp("/register");
    expect(await screen.findByLabelText("Email")).toBeDefined();
    expect(screen.queryByLabelText("Username")).toBeNull();
    expect(screen.queryByLabelText("Repeat password")).toBeNull();
    expect(screen.getByText(/the code we send makes your account/)).toBeDefined();
  });

  it("sends an expired sign-in link back to the Email tab", async () => {
    mockApi({
      "/api/session/me": json({ error: "unauthenticated" }, 401),
      "/api/session/config": json({ email_login: true, registration: true, captcha: null }),
      "/api/session/email/link": json({ error: "expired" }, 401),
    });
    window.location.hash = `token=${"A".repeat(43)}`;
    renderApp("/sign-in/email");
    expect(await screen.findByText(/This link has expired/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("button", { name: "Email me a code" })).toBeDefined();
    expect(screen.getByRole("tab", { name: /Email/, selected: true })).toBeDefined();
  });

  it("shows a home admin the people and the invitations with their status", async () => {
    mockApi({
      "/api/session/me": json({ username: "maria", role: "user", home: "maria", homeRole: "admin" }),
      "/api/home": json({
        id: "maria",
        name: "Flat 4",
        role: "admin",
        creator: true,
        can_invite: true,
        members: [
          { username: "maria", email: "maria@example.com", role: "admin", creator: true },
          { username: "dad", email: "dad@example.com", role: "user", creator: false },
        ],
        invites: [
          {
            id: "6f1c1b2a-1d2e-4f5a-8b9c-0d1e2f3a4b5c",
            email: "gran@example.com",
            role: "user",
            invited_by: "maria",
            status: "expired",
            created_at: 0,
            expires_at: 1,
            accepted_at: null,
            accepted_by: null,
          },
        ],
      }),
    });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Flat 4" })).toBeDefined();
    await openSection("People");
    await openSection("Invitations");
    expect(screen.getByText("owner")).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Role of dad" })).toBeDefined();
    expect(screen.getByText("gran@example.com")).toBeDefined();
    expect(screen.getByText("expired")).toBeDefined();
    expect(screen.getByText(/Link expires in 3 days\./)).toBeDefined();
    expect(screen.getByRole("button", { name: "Resend" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Invite" })).toBeDefined();
  });

  it("lets a member see the home and leave it, without the admin's controls", async () => {
    mockApi({
      "/api/session/me": json({ username: "dad", role: "user", home: "maria", homeRole: "user" }),
      "/api/home": json({
        id: "maria",
        name: "Flat 4",
        role: "user",
        creator: false,
        can_invite: false,
        members: [
          { username: "maria", email: null, role: "admin", creator: true },
          { username: "dad", email: null, role: "user", creator: false },
        ],
        invites: [],
      }),
    });
    renderApp("/settings");
    expect(await screen.findByText("You are a member of Flat 4.")).toBeDefined();
    expect(screen.queryByLabelText("Home name")).toBeNull();
    cleanup();
    renderApp("/");
    await openSection("People");
    expect(await screen.findByRole("button", { name: "Leave" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("opens an invitation link, names the home and joins it in one click", async () => {
    window.history.replaceState(null, "", `/invite#token=${"a".repeat(43)}`);
    mockApi({
      "/api/session/me": json({ error: "unauthenticated" }, 401),
      "/api/invites/lookup": json({ home: "Flat 4", invited_by: "maria", email: "dad@example.com", role: "user" }),
      "/api/invites/accept": json({ username: "dad", role: "user", home: "maria", homeRole: "user" }),
      "/api/home": json({
        id: "maria",
        name: "Flat 4",
        role: "user",
        creator: false,
        can_invite: false,
        members: [],
        invites: [],
      }),
    });
    renderApp("/invite");
    expect(await screen.findByText("maria invited you to join Flat 4.")).toBeDefined();
    expect(window.location.hash).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Join Flat 4" }));
    expect(await screen.findByRole("heading", { name: "Flat 4" })).toBeDefined();
  });

  it("folds the Home sections closed, remembers the ones opened, and lights up a coming-soon mark on a tap", async () => {
    const routes = {
      "/api/session/me": json({ username: "maria", role: "user", home: "maria", homeRole: "admin" }),
      "/api/home": json({
        id: "maria",
        name: "Flat 4",
        role: "admin",
        creator: true,
        can_invite: false,
        members: [],
        invites: [],
      }),
      "/api/devices": json([device]),
      "/api/connections": json([]),
    };
    mockApi(routes);
    renderApp("/");
    expect(await screen.findByRole("button", { name: "Devices", expanded: false })).toBeDefined();
    expect(screen.queryByText("Kitchen")).toBeNull();
    // Add device stays reachable while the section is closed
    expect(screen.getByRole("button", { name: "Add device" })).toBeDefined();
    await openSection("Devices");
    expect(await screen.findByText("Kitchen")).toBeDefined();
    expect(localStorage.getItem("section-open:devices")).toBe("1");

    await openSection("Coming soon");
    const claude = screen.getByRole("button", { name: "Claude: coming soon" });
    expect(claude.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText("Coming soon", { selector: "span, p" })).toBeNull();
    fireEvent.click(claude);
    expect(claude.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Coming soon", { selector: "span, p" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Gemini: coming soon" }));
    expect(claude.getAttribute("aria-pressed")).toBe("false");

    // A fresh render keeps Devices open and the rest closed
    cleanup();
    mockApi(routes);
    renderApp("/");
    expect(await screen.findByText("Kitchen")).toBeDefined();
    expect(screen.getByRole("button", { name: "People", expanded: false })).toBeDefined();
  });
});
