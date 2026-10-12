import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { POSTS, postPath } from "../src/content/posts";
import { metaFor } from "../src/content/routes";
import { jsonLd } from "../src/entry-server";

const [first, second, third] = POSTS;

function show(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("blog", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    if (second) {
      vi.setSystemTime(new Date(second.published));
    }
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("lists the posts that are out, newest first, and the menu reaches it", () => {
    show("/blog");
    const titles = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(titles).toEqual([second?.title, first?.title]);
    expect(screen.getAllByRole("link", { name: "Blog" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Development" })[0]?.getAttribute("href")).toBe("/#development");
  });

  it("shows a post that is out and a 404 for one that is not", () => {
    if (!first || !third) {
      throw new Error("posts missing");
    }
    show(postPath(first.slug));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(first.title);
    cleanup();
    show(postPath(third.slug));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("does not exist");
  });

  it("describes each post to search engines as an article", () => {
    if (!first) {
      throw new Error("posts missing");
    }
    const meta = metaFor(postPath(first.slug));
    expect(meta.article?.published).toBe(first.published);
    const data = JSON.parse(jsonLd(meta, `https://www.alexsay.com${postPath(first.slug)}`)) as {
      "@graph": { "@type": string; headline?: string; datePublished?: string }[];
    };
    expect(data["@graph"]).toContainEqual(
      expect.objectContaining({ "@type": "BlogPosting", headline: first.title, datePublished: first.published }),
    );
    const home = JSON.parse(jsonLd(metaFor("/"), "https://www.alexsay.com/")) as { "@graph": { "@type": string }[] };
    expect(home["@graph"].map((node) => node["@type"])).toContain("SoftwareApplication");
  });
});
