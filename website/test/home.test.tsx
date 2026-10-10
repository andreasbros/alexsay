import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/App";

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

  it("renders the 404 page for unknown paths", () => {
    render(
      <MemoryRouter initialEntries={["/nowhere"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("does not exist");
  });
});
