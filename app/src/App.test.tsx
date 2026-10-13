import { Theme } from "@radix-ui/themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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
    expect(await screen.findByText("Kitchen")).toBeDefined();
    expect(screen.getByText("online")).toBeDefined();
    expect(screen.getAllByRole("link", { name: /Assistant/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /Connections/ }).length).toBeGreaterThan(0);
  });

  it("explains how to get each provider's keys", async () => {
    mockApi({
      "/api/session/me": json({ username: "maria", role: "user" }),
      "/api/connections": json([]),
    });
    renderApp("/connections");
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
});
