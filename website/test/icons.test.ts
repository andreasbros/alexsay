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
