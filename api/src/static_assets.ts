/**
 * Hashed bundles under /assets are cached for a year as immutable. The single-page fallback must never
 * answer for one of them: in the moments of a deploy, a bundle the HTML names may not be live on an
 * edge yet, and a fallback page served in its place would be cached as that stylesheet or script for
 * good (seen on an iPhone on 15 Oct 2026: the app rendered with no CSS until the cache was cleared).
 */
export const BUNDLE_PREFIX = "/assets/";

/** The asset response as served, or a short-lived 404 when the fallback page stood in for a bundle. */
export function guardBundle(pathname: string, response: Response): Response {
  if (!pathname.startsWith(BUNDLE_PREFIX)) {
    return response;
  }
  const type = response.headers.get("content-type") ?? "";
  if (response.ok && type.includes("text/html")) {
    return new Response("not found", {
      status: 404,
      headers: { "cache-control": "no-store", "content-type": "text/plain" },
    });
  }
  return response;
}
