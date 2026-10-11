import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { localeInstructions } from "../src/locale";
import { contextInstructions, loadContext } from "../src/memory";
import { APP, addUser, call, json, resetDb, signIn } from "./helpers";

describe("locale and time zone", () => {
  beforeEach(async () => {
    await resetDb();
    await addUser("maria", "maria-pass", "user");
  });

  it("defaults to British English in London and can be changed per account, with bad values refused", async () => {
    const maria = await signIn("maria", "maria-pass");
    expect(await (await call(`${APP}/api/session/me`, {}, maria)).json()).toMatchObject({
      locale: "en-GB",
      timezone: "Europe/London",
    });
    const changed = await json(
      `${APP}/api/session/settings`,
      "PATCH",
      { locale: "de-DE", timezone: "Europe/Berlin" },
      maria,
    );
    expect(await changed.json()).toMatchObject({ locale: "de-DE", timezone: "Europe/Berlin" });
    expect((await json(`${APP}/api/session/settings`, "PATCH", { timezone: "Mars/Olympus" }, maria)).status).toBe(400);
    expect((await json(`${APP}/api/session/settings`, "PATCH", { locale: "english" }, maria)).status).toBe(400);
    const text = contextInstructions(await loadContext(env.DB, "maria"), new Date("2026-10-11T10:00:00Z"));
    expect(text).toMatch(/^Today is 2026-10-11 \(Sunday\), 12:00 in Europe\/Berlin/);
    expect(text).toContain("speak German as spoken in Germany");
    expect(text).toContain("Euro (EUR)");
  });

  it("describes the clock and conventions for any locale, and survives an unknown time zone", () => {
    const text = localeInstructions(
      { locale: "en-US", timezone: "America/New_York" },
      new Date("2026-01-05T01:30:00Z"),
    );
    expect(text).toMatch(/^Today is 2026-01-04 \(Sunday\), 20:30 in America\/New_York/);
    expect(text).toContain("US Dollar (USD), written like $1,234.50");
    expect(text).toContain("dates are written like 1/4/2026");
    expect(localeInstructions({ locale: "fr", timezone: "Nowhere/Here" }, new Date("2026-10-11T10:00:00Z"))).toContain(
      "in Europe/London",
    );
  });
});
