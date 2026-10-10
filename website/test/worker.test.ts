import { describe, expect, it } from "vitest";
import { respond } from "../src/worker";

const assets = { fetch: async (request: Request) => new Response(`asset ${new URL(request.url).host}`) } as Fetcher;

describe("worker", () => {
  it("serves the site on the apex and on www alike", async () => {
    expect(await (await respond(new Request("https://alexsay.com/"), assets)).text()).toBe("asset alexsay.com");
    expect(await (await respond(new Request("https://www.alexsay.com/"), assets)).text()).toBe("asset www.alexsay.com");
  });
});
