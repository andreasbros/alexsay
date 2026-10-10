// Renders every route to static HTML on top of the client build: crawlers get full pages, the
// browser hydrates them. Runs after `vite build` and the SSR build.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const template = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const { render, ROUTES } = await import(path.join(root, "dist-ssr", "entry-server.js"));

const site = "https://www.alexsay.com";
const indexed = [];
for (const route of ROUTES) {
  const { html, head } = render(route.path);
  const page = template.replace("<!--app-head-->", head).replace("<!--app-html-->", html);
  const out =
    route.path === "/" ? path.join(dist, "index.html") : path.join(dist, route.path.replace(/^\//, ""), "index.html");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, page);
  if (!route.noindex) {
    indexed.push(`${site}${route.path}`);
  }
  console.log("prerendered", route.path);
}

// Cloudflare's 404-page handling serves /404.html for unknown paths
fs.copyFileSync(path.join(dist, "404", "index.html"), path.join(dist, "404.html"));

const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(
  path.join(dist, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${indexed
    .map((url) => `  <url><loc>${url}</loc><lastmod>${today}</lastmod></url>`)
    .join("\n")}\n</urlset>\n`,
);
fs.writeFileSync(path.join(dist, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`);
fs.rmSync(path.join(root, "dist-ssr"), { recursive: true, force: true });
