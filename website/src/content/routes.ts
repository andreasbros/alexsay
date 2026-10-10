/** Every prerendered page, with the meta the crawler sees. */
export interface RouteMeta {
  path: string;
  title: string;
  description: string;
  noindex?: boolean;
}

export const SITE_URL = "https://www.alexsay.com";

const HOME: RouteMeta = {
  path: "/",
  title: "Alexsay: the open-source home assistant speaker",
  description:
    "A voice assistant speaker you own. Raspberry Pi 5, a four-microphone array, your own AI keys, and the smart home of your choice.",
};

const NOT_FOUND: RouteMeta = {
  path: "/404",
  title: "Page not found · Alexsay",
  description: "That page does not exist.",
  noindex: true,
};

export const ROUTES: RouteMeta[] = [HOME, NOT_FOUND];

export function metaFor(url: string): RouteMeta {
  const clean = (url.split("?")[0] ?? "/").replace(/\/$/, "") || "/";
  return ROUTES.find((route) => route.path === clean) ?? NOT_FOUND;
}
