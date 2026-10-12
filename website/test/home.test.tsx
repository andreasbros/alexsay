import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";
import { ACTS } from "../src/content/terminal";

describe("home page", () => {
  afterEach(cleanup);

  it("shows the headline and the two primary destinations", () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("A speaker that listens to you.");
    const appLinks = screen.getAllByRole("link", { name: /open the app/i });
    expect(appLinks[0]?.getAttribute("href")).toBe("https://app.alexsay.com");
    const github = screen.getAllByRole("link", { name: /github/i });
    expect(github[0]?.getAttribute("href")).toBe("https://github.com/andreasbros/alexsay");
  });

  it("ends with a Development section: the terminal, the install line and the Rust points", () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 2, name: /Install it in one line/ })).toBeTruthy();
    expect(screen.getByRole("img", { name: /terminal installing alexsay/ })).toBeTruthy();
    expect(screen.getByText("curl -fsSL https://alexsay.com/install.sh | sh")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Blazing-fast Rust" })).toBeTruthy();
    const sections = document.querySelectorAll("main section, section");
    expect(sections[sections.length - 1]?.id).toBe("development");
  });

  it("plays install, training and a conversation that ends by offering more help", () => {
    expect(ACTS.map((act) => act.command)).toEqual([
      "curl -fsSL https://alexsay.com/install.sh | sh",
      "alexsay wake train",
      "alexsay run",
    ]);
    const poses = new Set(ACTS.map((act) => JSON.stringify(act.pose)));
    expect(poses.size).toBe(ACTS.length);
    expect(ACTS.at(-1)?.lines.at(-1)?.text).toContain("How else can I help?");
    const run = ACTS.at(-1)?.lines ?? [];
    expect(run.every((line) => line.stamp?.includes("2026-10-12T"))).toBe(true);
    expect(run.some((line) => line.text.includes("2026-10-12T"))).toBe(false);
    // Without the timestamp a line starts at its level tag, not a space
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
    const plain = (text: string) => text.replace(ansi, "");
    expect(run.every((line) => /^(INFO |DEBUG) \S/.test(plain(line.text)))).toBe(true);
    for (const act of ACTS) {
      for (const line of act.lines) {
        expect(line.text).not.toMatch(/\u2014/);
      }
    }
  });

  it("renders the 404 page for unknown paths", () => {
    render(
      <MemoryRouter initialEntries={["/nowhere"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("does not exist");
  });
});
