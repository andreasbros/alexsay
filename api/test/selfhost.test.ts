import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { assetsBinding, matches, parseHeaders } from "../src/selfhost/assets";
import { MIGRATIONS } from "../src/selfhost/migrations.generated";

const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("self-hosted server", () => {
  it("embeds every D1 migration, unchanged (run node scripts/selfhost-migrations.mjs after adding one)", () => {
    expect(MIGRATIONS.map((m) => m.name)).toEqual(env.TEST_MIGRATIONS.map((m) => m.name));
    for (const [i, migration] of env.TEST_MIGRATIONS.entries()) {
      const embedded = squash(MIGRATIONS[i]?.sql ?? "");
      for (const query of migration.queries) {
        expect(embedded).toContain(squash(query).replace(/;$/, ""));
      }
    }
  });

  it("reads _headers rules like Cloudflare does", () => {
    const rules = parseHeaders(
      "# app\n/*\n  X-Frame-Options: DENY\n  Content-Security-Policy: a: b\n/assets/*\n  Cache-Control: immutable\n",
    );
    expect(rules).toEqual([
      {
        pattern: "/*",
        headers: [
          ["X-Frame-Options", "DENY"],
          ["Content-Security-Policy", "a: b"],
        ],
      },
      { pattern: "/assets/*", headers: [["Cache-Control", "immutable"]] },
    ]);
    expect(matches("/assets/*", "/assets/x.js")).toBe(true);
    expect(matches("/index.html", "/")).toBe(false);
  });

  const files: Record<string, string> = {
    "/index.html": "<html>app</html>",
    "/assets/app.js": "console.log(1)",
    "/_headers": "/*\n  X-Frame-Options: DENY\n/assets/*\n  Cache-Control: immutable\n",
  };
  const disk = {
    fetch: async (input: RequestInfo | URL) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      const body = files[path];
      return body === undefined ? new Response("", { status: 404 }) : new Response(body);
    },
    connect: () => {
      throw new Error("unused");
    },
  } as unknown as Fetcher;
  const assets = assetsBinding(disk);

  it("serves files with their type and headers, the app for navigations, and nothing outside", async () => {
    const js = await assets.fetch("http://app/assets/app.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.headers.get("cache-control")).toBe("immutable");
    expect(js.headers.get("x-frame-options")).toBe("DENY");

    const root = await assets.fetch("http://app/");
    expect(await root.text()).toBe("<html>app</html>");

    const route = await assets.fetch("http://app/devices", { headers: { accept: "text/html" } });
    expect(route.status).toBe(200);
    expect(await route.text()).toBe("<html>app</html>");

    expect((await assets.fetch("http://app/devices")).status).toBe(404);
    expect((await assets.fetch("http://app/missing.js", { headers: { accept: "text/html" } })).status).toBe(200);
    expect((await assets.fetch("http://app/%2e%2e/secrets.toml")).status).toBe(404);
  });
});
