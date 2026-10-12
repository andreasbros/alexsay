import { SITE_URL } from "./site";

/** The blog: every post's meta, and which ones are out at a given moment. */
export interface PostMeta {
  slug: string;
  title: string;
  description: string;
  /** When it goes out (ISO, UTC). Before this the post 404s and stays out of the index, sitemap and feed. */
  published: string;
  minutes: number;
}

export const BLOG_TITLE = "The Alexsay blog";
export const BLOG_DESCRIPTION =
  "Releases, design notes and the reasoning behind Alexsay, the open-source voice assistant speaker you build and own.";

export const POSTS: PostMeta[] = [
  {
    slug: "alexsay-0-1-first-release",
    title: "Alexsay 0.1: the first release",
    description:
      "The first Alexsay release: one Rust binary for every platform, an on-device wake word, software echo cancellation, memory, phone calls, lights and your own server.",
    published: "2026-10-12T09:00:00Z",
    minutes: 4,
  },
  {
    slug: "open-source-voice-assistant-speaker",
    title: "The smart speaker is a closed box. Here is an open one.",
    description:
      "Why home assistant speakers still lack an open stack with your own AI, and how Alexsay does it: open hardware, open source, Rust, software echo cancellation and builds for every popular architecture.",
    published: "2026-10-14T09:00:00Z",
    minutes: 6,
  },
  {
    slug: "why-alexsay",
    title: "Why it is called Alexsay",
    description: "Alex, say. Aleksei. A name you can call across a room, and the reasons behind it.",
    published: "2026-10-16T09:00:00Z",
    minutes: 2,
  },
];

export const postPath = (slug: string) => `/blog/${slug}`;

export function isPublished(post: PostMeta, now: number): boolean {
  return Date.parse(post.published) <= now;
}

/** Newest first. */
export function publishedPosts(now: number): PostMeta[] {
  return POSTS.filter((post) => isPublished(post, now)).sort((a, b) => b.published.localeCompare(a.published));
}

export function postBySlug(slug: string): PostMeta | undefined {
  return POSTS.find((post) => post.slug === slug);
}

/** On the server (prerender) every post renders; the Worker removes the ones not out yet. */
export function visibleNow(): PostMeta[] {
  return typeof window === "undefined"
    ? [...POSTS].sort((a, b) => b.published.localeCompare(a.published))
    : publishedPosts(Date.now());
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The sitemap as of `now`: the indexed pages, plus every post that is out. */
export function sitemapXml(pages: string[], now: number): string {
  const today = new Date(now).toISOString().slice(0, 10);
  const posts = publishedPosts(now);
  const urls = [
    ...pages.map((path) => ({
      loc: `${SITE_URL}${path}`,
      lastmod: path === "/blog" && posts[0] ? posts[0].published.slice(0, 10) : today,
    })),
    ...posts.map((post) => ({ loc: `${SITE_URL}${postPath(post.slug)}`, lastmod: post.published.slice(0, 10) })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((url) => `  <url><loc>${xml(url.loc)}</loc><lastmod>${url.lastmod}</lastmod></url>`)
    .join("\n")}\n</urlset>\n`;
}

/** RSS 2.0 of the posts that are out. */
export function feedXml(now: number): string {
  const posts = publishedPosts(now);
  const items = posts
    .map(
      (post) => `    <item>
      <title>${xml(post.title)}</title>
      <link>${SITE_URL}${postPath(post.slug)}</link>
      <guid isPermaLink="true">${SITE_URL}${postPath(post.slug)}</guid>
      <pubDate>${new Date(post.published).toUTCString()}</pubDate>
      <description>${xml(post.description)}</description>
    </item>`,
    )
    .join("\n");
  const updated = posts[0] ? new Date(posts[0].published).toUTCString() : new Date(now).toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(BLOG_TITLE)}</title>
    <link>${SITE_URL}/blog</link>
    <atom:link href="${SITE_URL}/blog/feed.xml" rel="self" type="application/rss+xml" />
    <description>${xml(BLOG_DESCRIPTION)}</description>
    <language>en-gb</language>
    <lastBuildDate>${updated}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}
