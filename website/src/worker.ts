/** Both hosts serve the prerendered site; the canonical link tag points search engines at www. */
export function respond(request: Request, assets: Fetcher): Promise<Response> {
  return assets.fetch(request);
}

export default {
  fetch: (request, env) => respond(request, env.ASSETS),
} satisfies ExportedHandler<Env>;
