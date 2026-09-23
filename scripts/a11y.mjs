// ===========================================================================
//  scripts/a11y.mjs — audit axe-core de la page.
//
//    npm run a11y
//
//  @axe-core/cli veut un chromedriver telecharge au vol, impossible ici (la
//  politique de sortie bloque le CDN). On injecte donc le meme moteur,
//  axe-core, dans le Chromium deja installe : memes regles, meme verdict.
//
//  Sortie : toutes les violations, triees par gravite. Le script sort en
//  erreur s'il en reste une en "serious" ou "critical".
// ===========================================================================

import { AxeBuilder } from "@axe-core/playwright";
import { VIEWPORTS, launchBrowser, newPage, settle, startMockCycle, startPrelaunch, stopAll, waitForState } from "./harness.mjs";

const PORT_LIVE = 3051;
const PORT_PRELAUNCH = 3052;
const BLOCKING = new Set(["serious", "critical"]);

async function audit(browser, url, label, viewport) {
  const { ctx, page } = await newPage(browser, viewport);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await settle(page);
  const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  await ctx.close();

  const v = res.violations.sort((a, b) => Number(BLOCKING.has(b.impact)) - Number(BLOCKING.has(a.impact)));
  console.log(`\n${label} — ${viewport.name} ${viewport.width}x${viewport.height}`);
  if (!v.length) console.log("  aucune violation");
  for (const x of v) {
    console.log(`  [${x.impact}] ${x.id} — ${x.help} (${x.nodes.length})`);
    for (const n of x.nodes.slice(0, 4)) console.log(`      ${n.target.join(" ")}  ${(n.failureSummary || "").split("\n").slice(1, 3).join(" / ").trim()}`);
  }
  const inc = res.incomplete.filter((x) => BLOCKING.has(x.impact));
  for (const x of inc) console.log(`  [a verifier a la main] ${x.id} — ${x.help} (${x.nodes.length})`);
  return v.filter((x) => BLOCKING.has(x.impact));
}

async function main() {
  startMockCycle(PORT_LIVE);
  startPrelaunch(PORT_PRELAUNCH);
  const live = `http://127.0.0.1:${PORT_LIVE}`;
  const pre = `http://127.0.0.1:${PORT_PRELAUNCH}`;
  await waitForState(live, () => true, 30000, "le serveur");
  await waitForState(pre, (s) => s.prelaunch, 30000, "le mode pre-lancement");

  const browser = await launchBrowser();
  let blocking = 0;
  for (const v of VIEWPORTS) {
    blocking += (await audit(browser, live, "en marche", v)).length;
    blocking += (await audit(browser, pre, "pre-lancement", v)).length;
  }
  await browser.close();
  stopAll();

  console.log(`\n${blocking} violation(s) serious/critical`);
  process.exit(blocking ? 1 : 0);
}

main().catch((e) => { console.error(e); stopAll(); process.exit(1); });
