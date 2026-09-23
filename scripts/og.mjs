// ===========================================================================
//  scripts/og.mjs — regenere les deux images du site depuis le hero lui-meme.
//
//    npm run og
//
//    public/wheel-poster.jpg  1600x1000, le hero sans le texte : c'est ce que
//                             wheel.js affiche quand WebGL manque
//    public/og.png            1200x630, l'image de partage, composee par
//                             public/og.html (page dediee, hors navigation)
//
//  Les deux sortent du meme rendu Three.js, donc les couleurs ne peuvent pas
//  diverger du site.
// ===========================================================================

import fs from "fs";
import path from "path";
import { ROOT, launchBrowser, newPage, settle, sleep, startPrelaunch, stopAll, waitForState } from "./harness.mjs";

const PORT = 3031;
const PUB = path.join(ROOT, "public");

// Le poster doit montrer la roue, pas la page : on efface les calques de
// texte avant la capture.
const HIDE_COPY = `
  document.querySelectorAll('body > *').forEach(el => { if (!el.classList.contains('hero')) el.style.display = 'none'; });
  document.querySelectorAll('.hero-copy, .hero-fade, .scroll-hint').forEach(el => el.style.display = 'none');
`;

async function poster(browser, base) {
  const { ctx, page, errors } = await newPage(browser, { name: "poster", width: 1600, height: 1000 });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await settle(page, 3500);
  await page.evaluate(HIDE_COPY);
  await sleep(600);
  const file = path.join(PUB, "wheel-poster.jpg");
  await page.locator("#wheel-3d").screenshot({ path: file, type: "jpeg", quality: 82 });
  await ctx.close();
  return { file, errors };
}

async function og(browser, base) {
  const { ctx, page, errors } = await newPage(browser, { name: "og", width: 1200, height: 630 });
  await page.goto(`${base}/og.html`, { waitUntil: "domcontentloaded" });
  await settle(page, 3500);
  const file = path.join(PUB, "og.png");
  await page.screenshot({ path: file });
  await ctx.close();
  return { file, errors };
}

async function main() {
  startPrelaunch(PORT);
  const base = `http://127.0.0.1:${PORT}`;
  await waitForState(base, (s) => s.prelaunch, 30000, "le serveur");
  const browser = await launchBrowser();

  const steps = [poster];
  if (fs.existsSync(path.join(PUB, "og.html"))) steps.push(og);
  else console.log("public/og.html absent : og.png non regenere");

  for (const step of steps) {
    const { file, errors } = await step(browser, base);
    const kb = (fs.statSync(file).size / 1024).toFixed(0);
    console.log(`${path.basename(file)}  ${kb} Ko${errors.length ? "\n  ! console: " + errors.join(" | ") : ""}`);
  }

  await browser.close();
  stopAll();
}

main().catch((e) => { console.error(e); stopAll(); process.exit(1); });
