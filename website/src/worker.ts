import { feedXml, isPublished, postBySlug, sitemapXml } from "./content/posts";
import { INDEXED_PAGES } from "./content/routes";

const xmlResponse = (body: string, type: string) =>
  new Response(body, { headers: { "content-type": `${type}; charset=utf-8`, "cache-control": "public, max-age=600" } });

async function notFound(request: Request, assets: Fetcher): Promise<Response> {
  const page = await assets.fetch(new Request(new URL("/404.html", request.url)));
  return new Response(page.body, { status: 404, headers: page.headers });
}

/** Blog posts are scheduled: before its date a post is a 404 and the index, sitemap and feed leave it out. */
export async function respond(request: Request, assets: Fetcher, now = Date.now()): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  if (path === "/sitemap.xml") {
    return xmlResponse(sitemapXml(INDEXED_PAGES, now), "application/xml");
  }
  if (path === "/blog/feed.xml") {
    return xmlResponse(feedXml(now), "application/rss+xml");
  }
  const slug = /^\/blog\/([^/]+)$/.exec(path)?.[1];
  if (slug) {
    const post = postBySlug(slug);
    if (post && !isPublished(post, now)) {
      return notFound(request, assets);
    }
  }
  const response = await assets.fetch(request);
  if (path === "/blog" && typeof HTMLRewriter !== "undefined") {
    return new HTMLRewriter()
      .on("[data-publish]", {
        element(element) {
          const at = Date.parse(element.getAttribute("data-publish") ?? "");
          if (!(at <= now)) {
            element.remove();
          }
        },
      })
      .transform(response);
  }
  return response;
}

/** Both hosts serve the prerendered site; the canonical link tag points search engines at www. */
export default {
  fetch: (request, env) => respond(request, env.ASSETS),
} satisfies ExportedHandler<Env>;
