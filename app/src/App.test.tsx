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

  it("lists the signed-in user's speakers", async () => {
    mockApi({
      "/api/session/me": json({ username: "maria", role: "user" }),
      "/api/devices": json([device]),
    });
    renderApp();
    expect(await screen.findByText("Kitchen")).toBeDefined();
    expect(screen.getByText("online")).toBeDefined();
    expect(screen.getByRole("link", { name: /Assistant/ })).toBeDefined();
    expect(screen.getByRole("link", { name: /Connections/ })).toBeDefined();
  });
});
