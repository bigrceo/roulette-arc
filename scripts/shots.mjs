// ===========================================================================
//  scripts/shots.mjs — captures de reference du site.
//
//    npm run shots
//
//  Lance le faux noeud (mocknode.mjs), un serveur en mode normal et un
//  serveur en mode pre-lancement, puis capture la page dans chaque etat, en
//  desktop (1280x800) et en mobile (375x812). Les PNG atterrissent dans
//  shots/ (ignore par git).
//
//  Le CDN jsdelivr est bloque dans l'environnement d'execution : les imports
//  three@0.170.0 sont reroutes vers node_modules/three, qui est la meme
//  version, en devDependency. En production la page charge bien le CDN.
// ===========================================================================

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "shots");
const THREE_DIR = path.join(ROOT, "node_modules", "three");

const MOCK_CREATOR = "0xe239cdc5fbe977a8a141B72194D3CF8c41bC5BC6";
const TEST_KEY = "0xabababababababababababababababababababababababababababababababab";
const PORT_LIVE = 3010;
const PORT_PRELAUNCH = 3011;
const RPC_PORT = 8545;

// Le seuil de la spec (0.25) demande ~90 s de mock avant le verrouillage.
// On descend a 0.05 pour que `npm run shots` tienne en une minute ; rien
// d'autre ne change dans le cycle.
const THRESHOLD = process.env.SHOTS_THRESHOLD || "0.05";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 375, height: 812, isMobile: true, deviceScaleFactor: 2 },
];

const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];

function run(cmd, args, env, label) {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.env.SHOTS_VERBOSE && process.stdout.write(`[${label}] ${d}`));
  p.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
  procs.push(p);
  return p;
}

function stopAll() {
  for (const p of procs) { try { p.kill("SIGKILL"); } catch {} }
}
process.on("exit", stopAll);
process.on("SIGINT", () => { stopAll(); process.exit(130); });

async function waitFor(url, test, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      const j = await r.json();
      if (test(j)) return j;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout en attendant ${what} sur ${url}`);
    await sleep(500);
  }
}

// Le CDN est injoignable ici : on sert three depuis node_modules.
async function routeThree(ctx) {
  await ctx.route("https://cdn.jsdelivr.net/npm/three@0.170.0/**", async (route) => {
    const rel = new URL(route.request().url()).pathname.replace("/npm/three@0.170.0/", "");
    const file = path.join(THREE_DIR, rel);
    if (!file.startsWith(THREE_DIR) || !fs.existsSync(file)) return route.abort();
    await route.fulfill({ status: 200, contentType: "text/javascript", body: fs.readFileSync(file) });
  });
}

async function settle(page) {
  await page.waitForSelector("#wheel-3d.ready, #wheel-3d.fallback", { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => document.fonts.status === "loaded", null, { timeout: 15000 }).catch(() => {});
  await sleep(2500); // laisse les transitions d'entree se terminer
}

async function shoot(browser, url, file, viewport, before) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.deviceScaleFactor || 1, isMobile: !!viewport.isMobile, hasTouch: !!viewport.isMobile });
  await routeThree(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await settle(page);
  if (before) await before(page);
  await page.screenshot({ path: path.join(OUT, file) });
  await ctx.close();
  console.log(`  ${file}${errors.length ? "  [console: " + errors.length + " erreur(s)] " + errors.slice(0, 2).join(" | ") : ""}`);
  return errors;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const stateDir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "roulette-shots-"));

  console.log("noeud de test…");
  run("node", ["mocknode.mjs"], { MOCK_CREATOR }, "mock");
  await sleep(1200);

  const botEnv = {
    PRIVATE_KEY: TEST_KEY,
    TOKEN_ADDRESS: "0x1111111111111111111111111111111111111111",
    DEPLOY_BLOCK: "1000",
    RPC_URL: `http://127.0.0.1:${RPC_PORT}`,
    PONS_ESCROW: "0x2222222222222222222222222222222222222222",
    THRESHOLD,
    GAS_RESERVE: "0.005",
    DRAW_DELAY_BLOCKS: "480",
    TICK_SECONDS: "2",
    STATE_DIR: stateDir,
  };
  run("node", ["index.js"], { ...botEnv, PORT: String(PORT_LIVE) }, "bot");
  const preDir = stateDir + "-pre";
  fs.mkdirSync(preDir, { recursive: true });
  run("node", ["index.js"], { PORT: String(PORT_PRELAUNCH), STATE_DIR: preDir }, "prelaunch");

  const live = `http://127.0.0.1:${PORT_LIVE}`;
  const pre = `http://127.0.0.1:${PORT_PRELAUNCH}`;
  await waitFor(`${live}/api/state`, () => true, 30000, "le serveur");
  await waitFor(`${pre}/api/state`, (s) => s.prelaunch, 30000, "le mode pre-lancement");

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--hide-scrollbars"],
  });

  console.log("etat idle…");
  for (const v of VIEWPORTS) await shoot(browser, live, `idle-${v.name}.png`, v);

  console.log("etat pre-lancement…");
  for (const v of VIEWPORTS) await shoot(browser, pre, `prelaunch-${v.name}.png`, v);

  console.log("etat locked (on attend que le pot atteigne le seuil)…");
  await waitFor(`${live}/api/state`, (s) => s.pendingDraw, 180000, "pendingDraw");
  for (const v of VIEWPORTS) await shoot(browser, live, `locked-${v.name}.png`, v);

  await browser.close();
  stopAll();
  console.log(`\n${fs.readdirSync(OUT).filter((f) => f.endsWith(".png")).length} PNG dans shots/`);
}

main().catch((e) => { console.error(e); stopAll(); process.exit(1); });
