import { describe, expect, it } from "vitest";
import { guardBundle } from "../src/static_assets";

describe("hashed bundles", () => {
  it("never lets the app's page stand in for a bundle, and leaves everything else alone", async () => {
    const page = new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } });
    const guarded = guardBundle("/assets/index-abc123.css", page);
    expect(guarded.status).toBe(404);
    expect(guarded.headers.get("cache-control")).toBe("no-store");
    const css = new Response("body{}", { status: 200, headers: { "content-type": "text/css" } });
    expect(guardBundle("/assets/index-abc123.css", css)).toBe(css);
    const route = new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } });
    expect(guardBundle("/settings", route)).toBe(route);
    const missing = new Response("nope", { status: 404 });
    expect(guardBundle("/assets/gone.js", missing)).toBe(missing);
    expect(await guarded.text()).toBe("not found");
  });
});
