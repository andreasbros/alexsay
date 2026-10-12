import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { StaticRouter } from "react-router";
import { App } from "./App";
import { BLOG_TITLE } from "./content/posts";
import { metaFor, ROUTES, type RouteMeta, SITE_URL } from "./content/routes";
import { GITHUB_URL } from "./content/site";
import "./styles/base.css";

/** Called by scripts/prerender.mjs for every route: the page HTML and its head tags. */
export function render(url: string): { html: string; head: string } {
  const html = renderToString(
    <StrictMode>
      <StaticRouter location={url}>
        <App />
      </StaticRouter>
    </StrictMode>,
  );
  const meta = metaFor(url);
  const canonical = `${SITE_URL}${url === "/" ? "/" : url}`;
  const head = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
    `<link rel="canonical" href="${canonical}" />`,
    `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(BLOG_TITLE)}" href="${SITE_URL}/blog/feed.xml" />`,
    meta.noindex ? "" : `<meta name="robots" content="index, follow, max-image-preview:large" />`,
    `<meta property="og:type" content="${meta.article ? "article" : "website"}" />`,
    meta.article ? `<meta property="article:published_time" content="${meta.article.published}" />` : "",
    `<meta property="og:site_name" content="Alexsay" />`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    `<meta property="og:url" content="${canonical}" />`,
    `<meta property="og:image" content="${SITE_URL}/og.png" />`,
    `<meta property="og:image:alt" content="The Alexsay speaker, a charcoal fabric cylinder, on a side table" />`,
    `<meta property="og:locale" content="en_GB" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="theme-color" content="#0a0a0f" media="(prefers-color-scheme: dark)" />`,
    `<meta name="theme-color" content="#f7f7fa" media="(prefers-color-scheme: light)" />`,
    meta.noindex ? `<meta name="robots" content="noindex" />` : "",
    meta.noindex ? "" : `<script type="application/ld+json">${jsonLd(meta, canonical)}</script>`,
  ]
    .filter(Boolean)
    .join("\n    ");
  return { html, head };
}

export { ROUTES };

const ORGANIZATION = {
  "@type": "Organization",
  name: "Alexsay",
  url: SITE_URL,
  logo: `${SITE_URL}/icon-512.png`,
  sameAs: [GITHUB_URL],
};

/** Structured data for search engines: the product on the home page, the blog, and each post. */
export function jsonLd(meta: RouteMeta, canonical: string): string {
  const graph: Record<string, unknown>[] = [ORGANIZATION];
  if (meta.path === "/") {
    graph.push(
      { "@type": "WebSite", name: "Alexsay", url: SITE_URL },
      {
        "@type": "SoftwareApplication",
        name: "Alexsay",
        description: meta.description,
        url: SITE_URL,
        applicationCategory: "HomeApplication",
        operatingSystem: "Linux, Raspberry Pi OS, macOS, Windows",
        license: `${GITHUB_URL}/blob/main/LICENSE`,
        downloadUrl: `${GITHUB_URL}/releases/latest`,
        offers: { "@type": "Offer", price: "0", priceCurrency: "GBP" },
      },
    );
  } else if (meta.path === "/blog") {
    graph.push({
      "@type": "Blog",
      name: BLOG_TITLE,
      url: canonical,
      description: meta.description,
      publisher: ORGANIZATION,
    });
  } else if (meta.article) {
    graph.push({
      "@type": "BlogPosting",
      headline: meta.title.replace(/ · Alexsay$/, ""),
      description: meta.description,
      datePublished: meta.article.published,
      dateModified: meta.article.published,
      url: canonical,
      mainEntityOfPage: canonical,
      image: `${SITE_URL}/og.png`,
      author: ORGANIZATION,
      publisher: ORGANIZATION,
    });
  }
  // "<" escaped so text can never close the script tag
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
