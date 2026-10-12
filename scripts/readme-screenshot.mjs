// Captures the website's hero as it looks on a landscape screen, headline on the left and the speaker
// on the right, in the day and night themes, for the README:
//   node scripts/readme-screenshot.mjs [site url]   (default https://www.alexsay.com)
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const { chromium } = createRequire(join(root, "e2e/package.json"))("@playwright/test");
const site = process.argv[2] ?? "https://www.alexsay.com";
const out = join(root, "docs/media");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
for (const [scheme, name] of [
  ["light", "hero-day.jpg"],
  ["dark", "hero-night.jpg"],
]) {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await page.goto(site, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".hero img")].every((img) => img.complete && img.naturalWidth > 0),
  );
  await page.locator(".hero").screenshot({ path: join(out, name), type: "jpeg", quality: 85 });
  await page.close();
  console.log(`docs/media/${name}`);
}
await browser.close();
