/**
 * Static assets for the self-hosted server, as Cloudflare's assets binding serves them: files from
 * the app's build, a single-page-application fallback to index.html for navigations, content types,
 * and the headers declared in the build's `_headers` file.
 */

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  ico: "image/x-icon",
  woff2: "font/woff2",
  woff: "font/woff",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json",
  wav: "audio/wav",
  map: "application/json",
};

export interface HeaderRule {
  pattern: string;
  headers: [string, string][];
}

/** Parses Cloudflare's `_headers` format: a path pattern, then indented `Name: value` lines. */
export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) {
      continue;
    }
    if (!/^\s/.test(line)) {
      rules.push({ pattern: line.trim(), headers: [] });
      continue;
    }
    const at = line.indexOf(":");
    const rule = rules[rules.length - 1];
    if (rule && at > 0) {
      rule.headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
    }
  }
  return rules;
}

export function matches(pattern: string, path: string): boolean {
  if (pattern.endsWith("*")) {
    return path.startsWith(pattern.slice(0, -1));
  }
  return pattern === path;
}

function typeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[ext] ?? "application/octet-stream";
}

export function assetsBinding(disk: Fetcher): Fetcher {
  // Plain data only: a pending fetch cannot be shared between requests on workerd
  let rules: HeaderRule[] | null = null;
  const loadRules = async (): Promise<HeaderRule[]> => {
    if (!rules) {
      const res = await disk.fetch("http://assets/_headers").catch(() => null);
      rules = res?.ok ? parseHeaders(await res.text()) : [];
    }
    return rules;
  };
  const serve = async (path: string): Promise<Response | null> => {
    const res = await disk.fetch(`http://assets${path}`);
    if (!res.ok || res.headers.get("content-type")?.includes("directory")) {
      return null;
    }
    const headers = new Headers({ "content-type": typeOf(path) });
    for (const rule of await loadRules()) {
      if (matches(rule.pattern, path)) {
        for (const [name, value] of rule.headers) {
          headers.set(name, value);
        }
      }
    }
    return new Response(res.body, { status: 200, headers });
  };
  const fetchAsset = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    if (path.includes("..")) {
      return new Response("not found", { status: 404 });
    }
    const file = path.endsWith("/") ? `${path}index.html` : path;
    const found = (await serve(file)) ?? (path.includes(".") ? null : await serve(`${file}.html`));
    if (found) {
      return found;
    }
    // Single-page application: any other navigation gets the app, which routes on the client
    if ((request.headers.get("accept") ?? "").includes("text/html")) {
      const index = await serve("/index.html");
      if (index) {
        return index;
      }
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch: fetchAsset, connect: disk.connect.bind(disk) } as Fetcher;
}
