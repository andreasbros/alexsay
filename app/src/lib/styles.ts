/**
 * During a deploy a browser can fetch a stylesheet the page names before it is live and cache what came
 * back (the app's own HTML, served as the single-page fallback) as that stylesheet for a year. The app
 * then runs with no styles until the cache is cleared. This spots such a sheet (it has no rules), fetches
 * it past the cache and reloads the page, once per tab.
 */
export const HEALED_KEY = "styles-healed";

export interface SheetLink {
  href: string;
  sheet: { cssRules: { length: number } } | null;
}

/** The stylesheet links that loaded nothing usable. */
export function brokenSheets(links: SheetLink[]): SheetLink[] {
  return links.filter((link) => {
    try {
      return link.sheet === null || link.sheet.cssRules.length === 0;
    } catch {
      // A cross-origin sheet hides its rules; it is not ours to judge
      return false;
    }
  });
}

export async function healStyles(
  links: SheetLink[] = Array.from(
    document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href*="/assets/"]'),
  ),
  refetch: (href: string) => Promise<unknown> = (href) => fetch(href, { cache: "reload" }),
  reload: () => void = () => window.location.reload(),
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeSession(),
): Promise<boolean> {
  const broken = brokenSheets(links);
  if (broken.length === 0) {
    return false;
  }
  // One attempt per tab: a sheet that is truly empty must not reload the page forever
  if (storage?.getItem(HEALED_KEY)) {
    return false;
  }
  storage?.setItem(HEALED_KEY, "1");
  await Promise.all(broken.map((link) => refetch(link.href).catch(() => undefined)));
  reload();
  return true;
}

function safeSession(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
