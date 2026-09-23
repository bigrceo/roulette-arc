// ===========================================================================
//  scripts/perf.mjs — mesure du hero 3D.
//
//    npm run perf
//
//  Verifie les deux exigences de perf : la boucle ne rend rien quand le hero
//  est hors ecran, et le bloom est coupe sous 700 px. Affiche les draw calls
//  par image (window.ROULETTE.info), a reporter dans REPORT.md.
// ===========================================================================

import { VIEWPORTS, launchBrowser, newPage, settle, sleep, startPrelaunch, stopAll, waitForState } from "./harness.mjs";

const PORT = 3021;

async function main() {
  startPrelaunch(PORT);
  const base = `http://127.0.0.1:${PORT}`;
  await waitForState(base, (s) => s.prelaunch, 30000, "le serveur");
  const browser = await launchBrowser();

  for (const v of VIEWPORTS) {
    const { ctx, page, errors } = await newPage(browser, v);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await settle(page);

    const inView = await page.evaluate(() => window.ROULETTE.info);
    const f1 = await page.evaluate(() => window.ROULETTE.info.frames);
    await sleep(2000);
    const f2 = await page.evaluate(() => window.ROULETTE.info.frames);

    // on descend bien en dessous du hero
    await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
    await sleep(2000);
    const f3 = await page.evaluate(() => window.ROULETTE.info.frames);
    const callsOff = await page.evaluate(() => window.ROULETTE.info.calls);
    await sleep(2000);
    const f4 = await page.evaluate(() => window.ROULETTE.info.frames);

    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(1500);
    const f5 = await page.evaluate(() => window.ROULETTE.info.frames);

    console.log(`${v.name} ${v.width}x${v.height}`);
    console.log(`  bloom              ${inView.bloom ? "actif" : "coupe"}`);
    console.log(`  draw calls / image ${inView.calls}`);
    console.log(`  triangles / image  ${inView.triangles}`);
    console.log(`  fps dans le hero   ${((f2 - f1) / 2).toFixed(1)}`);
    console.log(`  images hors ecran  ${f4 - f3}  (attendu 0)`);
    console.log(`  draw calls figes   ${callsOff === inView.calls ? "oui" : `non (${callsOff} vs ${inView.calls})`}`);
    console.log(`  reprise au retour  ${f5 - f4 > 0 ? "oui" : "NON"}`);
    console.log(`  onScreen hors hero ${await page.evaluate(() => window.ROULETTE.info.onScreen)} (apres retour en haut)`);
    if (errors.length) console.log(`  ! console: ${errors.join(" | ")}`);
    await ctx.close();
  }

  await browser.close();
  stopAll();
}

main().catch((e) => { console.error(e); stopAll(); process.exit(1); });
