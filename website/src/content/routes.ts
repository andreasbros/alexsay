import { BLOG_DESCRIPTION, BLOG_TITLE, POSTS, postPath } from "./posts";
import { SITE_URL } from "./site";

export { SITE_URL };

/** Every prerendered page, with the meta the crawler sees. */
export interface RouteMeta {
  path: string;
  title: string;
  description: string;
  noindex?: boolean;
  /** Blog posts: published as an article, with its date. */
  article?: { published: string };
}

const HOME: RouteMeta = {
  path: "/",
  title: "Alexsay: the open-source home assistant speaker",
  description:
    "A voice assistant speaker you own. Raspberry Pi 5, a four-microphone array, your own AI keys, and the smart home of your choice. One Rust binary for Linux, macOS, Windows and the Raspberry Pi.",
};

const BLOG: RouteMeta = {
  path: "/blog",
  title: `${BLOG_TITLE}: releases and design notes`,
  description: BLOG_DESCRIPTION,
};

const NOT_FOUND: RouteMeta = {
  path: "/404",
  title: "Page not found · Alexsay",
  description: "That page does not exist.",
  noindex: true,
};

const POST_ROUTES: RouteMeta[] = POSTS.map((post) => ({
  path: postPath(post.slug),
  title: `${post.title} · Alexsay`,
  description: post.description,
  article: { published: post.published },
}));

export const ROUTES: RouteMeta[] = [HOME, BLOG, ...POST_ROUTES, NOT_FOUND];

/** The pages that are always in the sitemap; posts join it on their publication date. */
export const INDEXED_PAGES = [HOME.path, BLOG.path];

export function metaFor(url: string): RouteMeta {
  const clean = (url.split("?")[0] ?? "/").replace(/\/$/, "") || "/";
  return ROUTES.find((route) => route.path === clean) ?? NOT_FOUND;
}
