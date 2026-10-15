import { describe, expect, it, vi } from "vitest";
import { brokenSheets, HEALED_KEY, healStyles } from "./styles";

const memory = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
};

describe("styles that failed to load", () => {
  it("spots a sheet with no rules and leaves good or foreign ones alone", () => {
    const empty = { href: "/assets/index-1.css", sheet: { cssRules: { length: 0 } } };
    const good = { href: "/assets/index-2.css", sheet: { cssRules: { length: 40 } } };
    const none = { href: "/assets/index-3.css", sheet: null };
    const foreign = {
      href: "https://fonts.googleapis.com/css2",
      sheet: {
        get cssRules(): { length: number } {
          throw new Error("SecurityError");
        },
      },
    };
    expect(brokenSheets([empty, good, none, foreign])).toEqual([empty, none]);
  });

  it("fetches the broken sheet past the cache and reloads once per tab", async () => {
    const refetch = vi.fn(async () => undefined);
    const reload = vi.fn();
    const storage = memory();
    const empty = { href: "/assets/index-1.css", sheet: { cssRules: { length: 0 } } };
    expect(await healStyles([empty], refetch, reload, storage)).toBe(true);
    expect(refetch).toHaveBeenCalledWith("/assets/index-1.css");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(HEALED_KEY)).toBe("1");
    // Still broken after the reload: no second attempt
    expect(await healStyles([empty], refetch, reload, storage)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    // Nothing broken: nothing happens
    const good = { href: "/assets/index-2.css", sheet: { cssRules: { length: 3 } } };
    expect(await healStyles([good], refetch, reload, memory())).toBe(false);
  });
});
