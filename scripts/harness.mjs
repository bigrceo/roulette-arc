// ===========================================================================
//  scripts/harness.mjs — plomberie commune aux scripts de capture et de
//  mesure : demarrer un serveur, attendre /api/state, ouvrir Chromium.
//
//  Note d'environnement : cdn.jsdelivr.net est bloque par la politique de
//  sortie de la machine de build. `routeThree` sert three@0.170.0 depuis
//  node_modules (meme version, devDependency) pendant les captures. En
//  production la page charge bien le CDN epingle.
// ===========================================================================

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { ethers } from "ethers";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const THREE_DIR = path.join(ROOT, "node_modules", "three");
export const CDN = "https://cdn.jsdelivr.net/npm/three@0.170.0/";
export const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";

// Le bot refuse de claim si le destinataire des fees n'est pas son propre
// wallet : le faux noeud et le bot doivent donc partager une adresse. On tire
// une paire jetable a chaque execution plutot que d'ecrire une cle dans le
// depot — elle ne sort jamais de la memoire du processus et ne touche que
// mocknode.mjs.
const THROWAWAY = ethers.Wallet.createRandom();
export const MOCK_CREATOR = THROWAWAY.address;
export const TEST_KEY = THROWAWAY.privateKey;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const procs = [];
export function stopAll() { for (const p of procs) { try { p.kill("SIGKILL"); } catch {} } procs.length = 0; }
process.on("exit", stopAll);
process.on("SIGINT", () => { stopAll(); process.exit(130); });

export function run(args, env, label) {
  const p = spawn("node", args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[${label}] ${d}`));
  p.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
  procs.push(p);
  return p;
}

export function tmpStateDir(tag) {
  return fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", `roulette-${tag}-`));
}

// Serveur en mode pre-lancement : pas de TOKEN_ADDRESS, aucune chaine requise.
export function startPrelaunch(port) {
  return run(["index.js"], { PORT: String(port), STATE_DIR: tmpStateDir("pre") }, "prelaunch");
}

// Cycle complet : faux noeud + bot branche dessus.
export function startMockCycle(port, { threshold = "0.05", drawDelay = "480" } = {}) {
  run(["mocknode.mjs"], { MOCK_CREATOR }, "mock");
  return run(["index.js"], {
    PRIVATE_KEY: TEST_KEY,
    TOKEN_ADDRESS: "0x1111111111111111111111111111111111111111",
    DEPLOY_BLOCK: "1000",
    RPC_URL: "http://127.0.0.1:8545",
    PONS_ESCROW: "0x2222222222222222222222222222222222222222",
    THRESHOLD: threshold,
    GAS_RESERVE: "0.005",
    DRAW_DELAY_BLOCKS: drawDelay,
    TICK_SECONDS: "2",
    STATE_DIR: tmpStateDir("state"),
    PORT: String(port),
  }, "bot");
}

export async function waitForState(base, test, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    try {
      const s = await (await fetch(`${base}/api/state`)).json();
      if (test(s)) return s;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout en attendant ${what}`);
    await sleep(500);
  }
}

export async function launchBrowser() {
  return chromium.launch({
    executablePath: CHROMIUM,
    // swiftshader : pas de GPU sur la machine de build
    args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--hide-scrollbars"],
  });
}

export async function routeThree(ctx) {
  await ctx.route(CDN + "**", async (route) => {
    const rel = new URL(route.request().url()).pathname.replace("/npm/three@0.170.0/", "");
    const file = path.join(THREE_DIR, rel);
    if (!file.startsWith(THREE_DIR) || !fs.existsSync(file)) return route.abort();
    await route.fulfill({ status: 200, contentType: "text/javascript", body: fs.readFileSync(file) });
  });
}

export const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 375, height: 812, isMobile: true, deviceScaleFactor: 2 },
];

export async function newPage(browser, viewport, opts = {}) {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true, // le proxy de la machine de build re-signe le TLS
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor || 1,
    isMobile: !!viewport.isMobile,
    hasTouch: !!viewport.isMobile,
    ...opts,
  });
  await routeThree(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  return { ctx, page, errors };
}

// Attend la roue (ou son fallback), les polices, puis les transitions d'entree.
export async function settle(page, wait = 2500) {
  await page.waitForSelector("#wheel-3d.ready, #wheel-3d.fallback", { timeout: 20000 }).catch(() => {});
  await page.waitForFunction(() => document.fonts.status === "loaded", null, { timeout: 15000 }).catch(() => {});
  await sleep(wait);
}
