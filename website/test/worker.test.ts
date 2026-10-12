import { describe, expect, it } from "vitest";
import { feedXml, POSTS, postPath, publishedPosts, sitemapXml } from "../src/content/posts";
import { respond } from "../src/worker";

const assets = {
  fetch: async (request: Request) => new Response(`asset ${new URL(request.url).host}${new URL(request.url).pathname}`),
} as Fetcher;

const [first, second, third] = POSTS;
const at = (iso: string) => Date.parse(iso);

describe("worker", () => {
  it("serves the site on the apex and on www alike", async () => {
    expect(await (await respond(new Request("https://alexsay.com/"), assets)).text()).toBe("asset alexsay.com/");
    expect(await (await respond(new Request("https://www.alexsay.com/"), assets)).text()).toBe(
      "asset www.alexsay.com/",
    );
  });

  it("schedules the posts two days apart", () => {
    expect(POSTS).toHaveLength(3);
    const days = POSTS.map((post) => at(post.published) / 86_400_000);
    expect(days.slice(1).map((day, i) => day - (days[i] ?? 0))).toEqual([2, 2]);
  });

  it("a post is a 404 until its date, then served", async () => {
    if (!second) {
      throw new Error("no second post");
    }
    const url = `https://www.alexsay.com${postPath(second.slug)}`;
    const before = await respond(new Request(url), assets, at(second.published) - 1);
    expect(before.status).toBe(404);
    expect(await before.text()).toBe("asset www.alexsay.com/404.html");
    const after = await respond(new Request(`${url}/`), assets, at(second.published));
    expect(after.status).toBe(200);
    expect(await after.text()).toContain(second.slug);
  });

  it("the sitemap and the feed list only the posts that are out, newest first", async () => {
    if (!first || !second || !third) {
      throw new Error("posts missing");
    }
    const now = at(second.published);
    expect(publishedPosts(now).map((post) => post.slug)).toEqual([second.slug, first.slug]);
    const sitemap = await (await respond(new Request("https://www.alexsay.com/sitemap.xml"), assets, now)).text();
    expect(sitemap).toContain("<loc>https://www.alexsay.com/</loc>");
    expect(sitemap).toContain("<loc>https://www.alexsay.com/blog</loc>");
    expect(sitemap).toContain(second.slug);
    expect(sitemap).not.toContain(third.slug);
    const feed = await respond(new Request("https://www.alexsay.com/blog/feed.xml"), assets, now);
    expect(feed.headers.get("content-type")).toContain("application/rss+xml");
    const body = await feed.text();
    expect(body.indexOf(second.slug)).toBeLessThan(body.indexOf(first.slug));
    expect(body).not.toContain(third.slug);
    expect(sitemapXml(["/"], at(first.published) - 1)).not.toContain("/blog/");
    expect(feedXml(at(third.published))).toContain(third.slug);
  });
});
