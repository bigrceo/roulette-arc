// ===========================================================================
//  scripts/shots.mjs — captures de reference du site.
//
//    npm run shots
//
//  Demarre le faux noeud, un serveur normal et un serveur en mode
//  pre-lancement, puis capture la page dans chaque etat, en desktop
//  (1280x800) et en mobile (375x812). Les PNG atterrissent dans shots/,
//  ignore par git.
//
//    idle       la roue tourne, le pot se remplit
//    locked     le bloc de tirage est annonce (on attend pendingDraw)
//    paid       un gagnant vient d'etre paye (etat injecte cote fetch)
//    prelaunch  serveur sans TOKEN_ADDRESS
//    nowebgl    WebGL indisponible : poster statique
//    noimportmap  pas de support des import maps (Safari < 16.4) : idem
//
//  webkit et firefox ne sont pas installables ici (cdn.playwright.dev et les
//  miroirs Mozilla sont bloques par la politique de sortie), donc tout est
//  capture sous Chromium. Voir REPORT.md.
// ===========================================================================

import fs from "fs";
import path from "path";
import {
  ROOT, VIEWPORTS, launchBrowser, newPage, settle, sleep,
  startMockCycle, startPrelaunch, stopAll, waitForState,
} from "./harness.mjs";

const OUT = path.join(ROOT, "shots");
const PORT_LIVE = 3010;
const PORT_PRELAUNCH = 3011;

// Le seuil de la spec (0.25) demande ~90 s de mock avant le verrouillage.
// On descend a 0.05 pour que `npm run shots` tienne en une minute ; rien
// d'autre ne change dans le cycle.
const THRESHOLD = process.env.SHOTS_THRESHOLD || "0.05";

// Etat `paid` sans attendre le tirage : on remplace /api/state cote page.
const FAKE_PAID = `
  const real = window.fetch;
  const s = await (await real('/api/state')).json();
  const fake = { ...s, pendingDraw: null, rounds: [{ round: 9, at: new Date().toISOString(), targetBlock: 4242,
    winner: '0xd74393ebf658274f4114f8db6c430dbc0206e3d7', txHash: '0x' + 'ab'.repeat(32), amount: 0.05, eligibleCount: 30 }, ...s.rounds] };
  window.fetch = (u) => u === '/api/state' ? Promise.resolve({ json: () => Promise.resolve(fake) }) : real(u);
  await load();
`;

async function shoot(browser, url, file, viewport, opts = {}) {
  const { ctx, page, errors } = await newPage(browser, viewport, opts.context);
  if (opts.route) await opts.route(ctx);
  if (opts.init) await page.addInitScript(opts.init);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await settle(page);
  if (opts.before) await opts.before(page);
  await page.screenshot({ path: path.join(OUT, file) });
  await ctx.close();
  console.log(`  ${file}${errors.length ? "\n     ! console: " + errors.join(" | ") : ""}`);
  return errors;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  console.log("demarrage du faux noeud et des serveurs…");
  startMockCycle(PORT_LIVE, { threshold: THRESHOLD });
  startPrelaunch(PORT_PRELAUNCH);

  const live = `http://127.0.0.1:${PORT_LIVE}`;
  const pre = `http://127.0.0.1:${PORT_PRELAUNCH}`;
  await waitForState(live, () => true, 30000, "le serveur");
  await waitForState(pre, (s) => s.prelaunch, 30000, "le mode pre-lancement");

  const browser = await launchBrowser();

  console.log("idle :");
  for (const v of VIEWPORTS) await shoot(browser, live, `idle-${v.name}.png`, v);

  console.log("pre-lancement :");
  for (const v of VIEWPORTS) await shoot(browser, pre, `prelaunch-${v.name}.png`, v);

  console.log("paid (etat injecte) :");
  for (const v of VIEWPORTS) {
    await shoot(browser, live, `paid-${v.name}.png`, v, {
      before: async (p) => { await p.evaluate(`(async () => {${FAKE_PAID}})()`); await sleep(2500); },
    });
  }

  console.log("sans WebGL :");
  for (const v of VIEWPORTS) {
    await shoot(browser, live, `nowebgl-${v.name}.png`, v, {
      init: () => {
        delete window.WebGLRenderingContext;
        delete window.WebGL2RenderingContext;
        HTMLCanvasElement.prototype.getContext = () => null;
      },
    });
  }

  console.log("sans import map (Safari < 16.4) :");
  await shoot(browser, live, "noimportmap-desktop.png", VIEWPORTS[0], {
    context: {},
    route: async (ctx) => {
      await ctx.route(live + "/", async (route) => {
        const r = await route.fetch();
        const body = (await r.text()).replace(/<script type="importmap">[\s\S]*?<\/script>/, "");
        await route.fulfill({ response: r, body, headers: { ...r.headers(), "content-type": "text/html; charset=utf-8" } });
      });
    },
  });

  console.log("locked (on attend que le pot atteigne le seuil) :");
  await waitForState(live, (s) => s.pendingDraw, 180000, "pendingDraw");
  for (const v of VIEWPORTS) await shoot(browser, live, `locked-${v.name}.png`, v);

  await browser.close();
  stopAll();
  const n = fs.readdirSync(OUT).filter((f) => f.endsWith(".png")).length;
  console.log(`\n${n} PNG dans shots/`);
}

main().catch((e) => { console.error(e); stopAll(); process.exit(1); });
