import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Browsers keep a favicon per page for weeks; a new version query is what makes them fetch a changed icon.
const ICON_VERSION = "?v=2";

describe("icons", () => {
  for (const page of ["../index.html", "../../app/index.html"]) {
    it(`${page} links every icon with the current version`, () => {
      const html = readFileSync(new URL(page, import.meta.url), "utf8");
      const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="([^"]+)"/g)].map((m) => m[1]);
      expect(hrefs).toHaveLength(5);
      for (const href of hrefs) {
        expect(href).toMatch(new RegExp(`\\${ICON_VERSION}$`));
      }
    });
  }
});

// A variable keeps Vite from turning the path into a bundled asset URL.
const BIMI_LOGO = "../public/bimi.svg";

describe("BIMI logo", () => {
  const svg = readFileSync(new URL(BIMI_LOGO, import.meta.url), "utf8");
  const root = /<svg[^>]*>/.exec(svg)?.[0] ?? "";

  it("is SVG Tiny Portable/Secure, as mail clients require", () => {
    expect(root).toContain('version="1.2"');
    expect(root).toContain('baseProfile="tiny-ps"');
    expect(root).toMatch(/viewBox="0 0 (\d+) \1"/);
    expect(root).not.toMatch(/\s(x|y)=/);
    expect(svg).toMatch(/<title>Alexsay<\/title>/);
    expect(svg).not.toMatch(/<script|<image|<style|href=|<animate/);
  });

  it("has a solid background, since clients crop it to a circle", () => {
    expect(svg).toMatch(/<rect width="100" height="100" fill="#[0-9A-F]{6}"\/>/);
  });
});
