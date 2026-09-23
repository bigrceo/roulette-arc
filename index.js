// ===========================================================================
//  $ROULETTE — bot et serveur web.
//
//  Le pot s'alimente des creator fees du launch. Au seuil, un bloc futur
//  est annonce ; quand il tombe, son hash designe un holder qui recoit tout.
//
//  Rien de specifique a la chaine ici : tout vit dans chain.js.
// ===========================================================================

import { ethers } from "ethers";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import {
  CHAIN,
  PONS,
  ERC20_ABI,
  claimCandidates,
  discoverLaunch,
  pendingInEscrow,
  feeIsNative,
} from "./chain.js";
import { eligibleHolders, pickWinner, splitAmount, applyTransfer, reconcileBalance } from "./lib.js";
import * as X from "./x.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const PK = process.env.PRIVATE_KEY;
const TOKEN = (process.env.TOKEN_ADDRESS || "").toLowerCase();
const DEPLOY_BLOCK = Number(process.env.DEPLOY_BLOCK || 0);
const POT_SHARE = Number(process.env.POT_SHARE || 70);
const DRAW_DELAY = Number(process.env.DRAW_DELAY_BLOCKS || 600);
const TICK_SECONDS = Number(process.env.TICK_SECONDS || 30);
const PORT = Number(process.env.PORT || 3000);
const SITE_URL = process.env.SITE_URL || "https://rouletteonchain.world";

const FEE_DECIMALS = PONS.feeDecimals;
const THRESHOLD = ethers.parseUnits(process.env.THRESHOLD || "0.02", FEE_DECIMALS);
// Pot et gas sont le meme actif quand les fees sont en ETH : on garde
// toujours de quoi payer les transactions a venir. Quand les fees sont un
// ERC20 (ex. USDG), le gas vient d'ailleurs et la reserve ne s'applique pas
// au pot.
const GAS_RESERVE = feeIsNative()
  ? ethers.parseUnits(process.env.GAS_RESERVE || "0.003", FEE_DECIMALS)
  : 0n;

const STATE_FILE = path.join(process.env.STATE_DIR || __dirname, "state.json");

// ---------------------------------------------------------------------------
// PROVIDER — une panne RPC ne doit jamais tuer le process : le site reste
// servi et le bot reessaie au tick suivant.
// ---------------------------------------------------------------------------
const provider = new ethers.JsonRpcProvider(CHAIN.rpc, CHAIN.id, {
  staticNetwork: true,
});
process.on("unhandledRejection", (e) => console.error("promesse non geree:", e?.message || e));
process.on("uncaughtException", (e) => console.error("exception:", e?.message || e));

const wallet = PK ? new ethers.Wallet(PK, provider) : null;
const token = TOKEN ? new ethers.Contract(TOKEN, ERC20_ABI, provider) : null;

let TOTAL_SUPPLY = 0n;
let EXCLUDED = new Set();
let FEE_SYMBOL = feeIsNative() ? CHAIN.nativeSymbol : "";
let LAUNCH = null; // config lue sur la factory Pons
let PENDING = 0n; // en attente dans l'escrow, pas encore reclame
let CLAIM_BLOCKED = null; // raison pour laquelle on ne reclame pas
let CLAIM_FN = null; // { address, sig, fn, args } — resolu au premier claim

// ---------------------------------------------------------------------------
// ETAT
// ---------------------------------------------------------------------------
function freshState() {
  return {
    lastBlock: DEPLOY_BLOCK,
    balances: {},
    pot: "0",
    devAccrued: "0",
    pendingDraw: null,
    rounds: [],
  };
}
let state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
  : freshState();

function save() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
const amt = (raw) => Number(ethers.formatUnits(raw, FEE_DECIMALS));
const fmtAmt = (raw) => amt(raw).toLocaleString("en-US", { maximumFractionDigits: 4 });
const shortAddr = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");

// ---------------------------------------------------------------------------
// POSTS X — jamais bloquants. `state.posted` garde ce qui a deja ete publie
// pour qu'un redemarrage ne reposte pas.
// ---------------------------------------------------------------------------
async function social(kind, key, vars) {
  if (!X.xEnabled()) return;
  state.posted ||= {};
  const id = `${kind}:${key}`;
  if (state.posted[id]) return;
  try {
    const tweetId = await X.post(
      X.fill(X.TEMPLATES[kind], {
        symbol: FEE_SYMBOL,
        site: SITE_URL,
        explorer: CHAIN.explorer,
        threshold: fmtAmt(THRESHOLD),
        ...vars,
      })
    );
    if (tweetId) {
      state.posted[id] = tweetId;
      save();
      console.log(`X: ${kind} #${key} publie (${tweetId})`);
    }
  } catch (e) {
    console.error(`X ${kind} KO:`, e.message);
  }
}

// ---------------------------------------------------------------------------
// SOLDE DE L'ACTIF DE PAIEMENT
// ---------------------------------------------------------------------------
async function feeBalance(addr) {
  if (feeIsNative()) {
    // appel direct : provider.getBalance() met en cache par bloc, ce qui
    // masquerait la variation qu'on cherche a mesurer
    const hex = await provider.send("eth_getBalance", [addr, "latest"]);
    return BigInt(hex);
  }
  return await new ethers.Contract(PONS.feeAsset, ERC20_ABI, provider).balanceOf(addr);
}

async function sendFees(to, value) {
  if (feeIsNative()) {
    const tx = await wallet.sendTransaction({ to, value });
    return (await tx.wait()).hash;
  }
  const c = new ethers.Contract(PONS.feeAsset, ERC20_ABI, wallet);
  const tx = await c.transfer(to, value);
  return (await tx.wait()).hash;
}

// ---------------------------------------------------------------------------
// INDEXATION DES HOLDERS
// Reconstruit les soldes depuis les events Transfer. N'importe qui peut
// refaire exactement le meme calcul : c'est ce qui rend le tirage verifiable.
// ---------------------------------------------------------------------------
const iface = new ethers.Interface(ERC20_ABI);
const TRANSFER_TOPIC = iface.getEvent("Transfer").topicHash;

async function syncBalances(upTo) {
  let from = state.lastBlock + 1;
  if (from > upTo) return;

  while (from <= upTo) {
    const to = Math.min(upTo, from + 3000);
    let logs;
    try {
      logs = await provider.getLogs({
        address: TOKEN,
        topics: [TRANSFER_TOPIC],
        fromBlock: from,
        toBlock: to,
      });
    } catch (e) {
      console.error(`getLogs KO ${from}-${to}:`, e.shortMessage || e.message);
      return; // on retentera la meme plage au tick suivant
    }

    for (const log of logs) {
      const { args } = iface.parseLog(log);
      applyTransfer(state.balances, args.from, args.to, args.value, ethers.ZeroAddress.toLowerCase());
    }

    state.lastBlock = to;
    from = to + 1;
    save();
  }
}

// ---------------------------------------------------------------------------
// CLAIM DES CREATOR FEES
//
// La signature reelle du retrait n'est pas garantie par la doc : on essaie
// les candidats une fois, on retient celui qui marche, et on mesure le
// montant recu par la variation du solde. Mesurer bat deviner.
// ---------------------------------------------------------------------------
async function resolveClaimFn() {
  if (CLAIM_FN) return CLAIM_FN;
  if (!PONS.escrow) return null;

  for (const cand of claimCandidates()) {
    const fn = cand.sig.match(/function (\w+)/)[1];
    const args = cand.args(wallet.address, TOKEN, PONS.feeAsset);
    const c = new ethers.Contract(PONS.escrow, [cand.sig], wallet);
    try {
      await c[fn].staticCall(...args);
      CLAIM_FN = { sig: cand.sig, fn, args };
      console.log(`claim resolu : ${cand.sig}`);
      return CLAIM_FN;
    } catch (e) {
      const m = String(e.shortMessage || e.message || "");
      if (!m.includes("missing revert data") && !m.includes("no data present")) {
        // la fonction existe mais refuse (souvent : rien a reclamer).
        // On la retient : elle passera quand il y aura quelque chose.
        CLAIM_FN = { sig: cand.sig, fn, args, mayRevertWhenEmpty: true };
        console.log(`claim probable : ${cand.sig}`);
        return CLAIM_FN;
      }
    }
  }
  return null;
}

/** Declenche le retrait des fees. Ne compte rien : la comptabilite est
 *  faite separement, a partir du solde reel du wallet. */
async function claimFees() {
  if (!wallet || !PONS.escrow || CLAIM_BLOCKED) return;

  // montant en attente, pour l'affichage ; le claim reel est mesure au solde
  try {
    PENDING = await pendingInEscrow(provider, wallet.address);
  } catch {}
  if (PENDING === 0n) return; // l'escrow revert NoBalance() quand il est vide

  const target = await resolveClaimFn();
  if (!target) {
    console.error("aucune signature de retrait connue — lance `npm run probe`");
    return;
  }

  const c = new ethers.Contract(PONS.escrow, [target.sig], wallet);

  // rien a reclamer : la simulation revert, cas normal et frequent
  try {
    await c[target.fn].staticCall(...target.args);
  } catch {
    return;
  }

  try {
    const tx = await c[target.fn](...target.args);
    await tx.wait();
  } catch (e) {
    console.error("claim KO:", e.shortMessage || e.message);
  }
}

/**
 * Comptabilite, faite a partir du solde reel du wallet plutot que du delta
 * autour d'une transaction.
 *
 * Pourquoi : mesurer avant/apres un claim est fragile — le gas sort du meme
 * solde quand les fees sont en actif natif, un RPC peut servir une valeur
 * d'un bloc anterieur, et un claim qui echoue a moitie fausse le compte.
 * Ici on regarde ce qui est reellement disponible, a chaque tick. Tout
 * entrant est reparti, quelle que soit sa provenance.
 */
async function reconcile() {
  if (!wallet) return;

  const balance = await feeBalance(wallet.address);
  const { incoming, pot, dev } = reconcileBalance(
    balance,
    GAS_RESERVE,
    BigInt(state.pot),
    BigInt(state.devAccrued),
    POT_SHARE
  );
  if (incoming === 0n) return;

  state.pot = (BigInt(state.pot) + pot).toString();
  state.devAccrued = (BigInt(state.devAccrued) + dev).toString();
  save();
  console.log(
    `+${amt(incoming)} → pot +${amt(pot)} / dev +${amt(dev)}   (pot total ${amt(BigInt(state.pot))})`
  );

  // a mi-chemin du seuil, une fois par round
  const potNow = BigInt(state.pot);
  if (!state.pendingDraw && potNow * 2n >= THRESHOLD && potNow < THRESHOLD) {
    await social("half", state.rounds.length + 1, { pot: fmtAmt(potNow) });
  }
}

// ---------------------------------------------------------------------------
// CYCLE DU ROUND
// ---------------------------------------------------------------------------
async function announceDrawIfReady(head) {
  if (state.pendingDraw) return;
  const pot = BigInt(state.pot);
  if (pot < THRESHOLD) return;

  state.pendingDraw = {
    round: state.rounds.length + 1,
    targetBlock: head + DRAW_DELAY,
    pot: pot.toString(),
    announcedAt: new Date().toISOString(),
    announcedAtBlock: head,
  };
  save();
  console.log(
    `ROUND ${state.pendingDraw.round} annonce — pot ${amt(pot)}, tirage au bloc ${state.pendingDraw.targetBlock}`
  );
  await social("announce", state.pendingDraw.round, {
    round: state.pendingDraw.round,
    pot: fmtAmt(pot),
    block: state.pendingDraw.targetBlock,
  });
}

async function executeDrawIfDue(head) {
  const d = state.pendingDraw;
  if (!d || head < d.targetBlock) return;

  // soldes figes exactement au bloc du tirage : reproductible par quiconque
  await syncBalances(d.targetBlock);
  if (state.lastBlock < d.targetBlock) return; // indexation incomplete, on retente

  const block = await provider.getBlock(d.targetBlock);
  if (!block || !block.hash) {
    console.error("bloc cible illisible, nouvelle tentative au prochain tick");
    return;
  }

  const { list, total } = eligibleHolders(state.balances, EXCLUDED, TOTAL_SUPPLY);
  if (!list.length) {
    console.log("aucun holder eligible — round reporte");
    state.pendingDraw = null;
    save();
    return;
  }

  const winner = pickWinner(list, total, block.hash);

  // on ne vide jamais le wallet : la reserve paie les tx suivantes
  let payout = BigInt(d.pot);
  if (feeIsNative()) {
    const bal = await feeBalance(wallet.address);
    const max = bal > GAS_RESERVE ? bal - GAS_RESERVE : 0n;
    if (payout > max) {
      console.log(`payout reduit a ${amt(max)} pour garder la reserve de gas`);
      payout = max;
    }
  }

  let txHash = null,
    error = null;
  if (payout > 0n) {
    try {
      txHash = await sendFees(winner.addr, payout);
      state.pot = (BigInt(state.pot) - payout).toString();
    } catch (e) {
      error = e.shortMessage || e.message;
      console.error("paiement KO:", error);
    }
  } else {
    error = "solde insuffisant apres reserve de gas";
  }

  state.rounds.unshift({
    round: d.round,
    at: new Date().toISOString(),
    targetBlock: d.targetBlock,
    blockHash: block.hash,
    winner: winner.addr,
    winnerWeightPct: total > 0n ? Number((winner.weight * 10000n) / total) / 100 : 0,
    amount: amt(payout),
    eligibleCount: list.length,
    txHash,
    error,
  });
  state.pendingDraw = null;
  save();

  console.log(`ROUND ${d.round} — ${amt(payout)} → ${winner.addr} (${txHash || "ECHEC"})`);
  if (txHash) {
    await social("result", d.round, {
      round: d.round,
      pot: fmtAmt(payout),
      block: d.targetBlock,
      winner: shortAddr(winner.addr),
      tx: `${CHAIN.explorer}/tx/${txHash}`,
    });
  }
}

// ---------------------------------------------------------------------------
// BOUCLE
// ---------------------------------------------------------------------------
async function tick() {
  const head = await provider.getBlockNumber();
  await syncBalances(head);
  await claimFees();   // recupere les fees si le launchpad en a
  await reconcile();   // repartit ce qui est arrive, d'ou que ca vienne
  await announceDrawIfReady(head);
  await executeDrawIfDue(head);
}

// ---------------------------------------------------------------------------
// SERVEUR WEB
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// DEMO_MODE=true : avant le lancement, le site montre des chiffres simules,
// etiquetes "simulation" cote client (champ `demo`). Deterministe a partir de
// l'horloge : le pot monte, un tirage tombe toutes les ~40 minutes, les
// "rounds" n'ont ni tx ni adresse reelle. Aucun lien vers l'explorer.
// ---------------------------------------------------------------------------
const DEMO = /^(1|true|yes)$/i.test(process.env.DEMO_MODE || "");
function demoState() {
  const thr = amt(THRESHOLD);
  const CYCLE = 40 * 60 * 1000;
  const t = Date.now();
  const cycle = Math.floor(t / CYCLE);
  const phase = (t % CYCLE) / CYCLE; // 0..1 dans le cycle courant
  const pot = Number((thr * Math.min(1, phase * 1.08)).toFixed(4));
  const locked = phase > 0.93;
  const seed = (n) => { let x = Math.sin(n * 9301 + 49297) * 233280; return x - Math.floor(x); };
  const fakeAddr = (n) => "0x" + Array.from({ length: 40 }, (_, i) => "0123456789abcdef"[Math.floor(seed(n * 40 + i) * 16)]).join("");
  const rounds = [];
  for (let k = 1; k <= 6; k++) {
    const c = cycle - k;
    if (c < 0) break;
    rounds.push({
      round: c % 1000,
      at: new Date((c + 1) * CYCLE).toISOString(),
      targetBlock: 69900000 + (c % 1000) * 24000,
      blockHash: null,
      winner: fakeAddr(c),
      winnerWeightPct: Number((3 + seed(c) * 9).toFixed(2)),
      amount: Number((thr * (0.98 + seed(c + 7) * 0.1)).toFixed(4)),
      eligibleCount: 24 + Math.floor(seed(c + 3) * 30),
      txHash: null,
      simulated: true,
    });
  }
  return {
    prelaunch: false,
    demo: true,
    pot,
    pending: Number((thr * 0.04 * seed(cycle + 11)).toFixed(4)),
    threshold: thr,
    potShare: POT_SHARE,
    devShare: 100 - POT_SHARE,
    eligibleCount: 24 + Math.floor(seed(cycle + 5) * 30),
    totalPaid: Number(rounds.reduce((s, r) => s + r.amount, 0).toFixed(4)),
    pendingDraw: locked ? { round: cycle % 1000, targetBlock: 69900000 + (cycle % 1000) * 24000, pot: String(pot), announcedAt: new Date().toISOString() } : null,
    lastBlock: 69900000 + (cycle % 1000) * 24000 - 1800,
    rounds,
    token: "",
    symbol: PONS.feeAsset ? "" : CHAIN.nativeSymbol,
    explorer: CHAIN.explorer,
    rules: { minHoldPct: 0.1, weighting: "sqrt", drawDelayBlocks: DRAW_DELAY },
  };
}

function publicState() {
  if (!TOKEN && DEMO) return demoState();
  if (!TOKEN) {
    return {
      prelaunch: true,
      pot: 0,
      threshold: amt(THRESHOLD),
      potShare: POT_SHARE,
      devShare: 100 - POT_SHARE,
      eligibleCount: 0,
      totalPaid: 0,
      pendingDraw: null,
      rounds: [],
      token: "",
      symbol: PONS.feeAsset ? "" : CHAIN.nativeSymbol,
      explorer: CHAIN.explorer,
      rules: { minHoldPct: 0.1, weighting: "sqrt", drawDelayBlocks: DRAW_DELAY },
    };
  }
  const { list } = eligibleHolders(state.balances, EXCLUDED, TOTAL_SUPPLY);
  return {
    token: TOKEN,
    symbol: FEE_SYMBOL,
    launch: LAUNCH && {
      curve: LAUNCH.curve,
      pairToken: LAUNCH.pairToken,
      creatorTaxBps: LAUNCH.creatorTaxBps,
      phase: LAUNCH.phase,
      protocolFeeShareBps: LAUNCH.policy?.protocolFeeShareBps ?? null,
    },
    pot: amt(BigInt(state.pot)),
    threshold: amt(THRESHOLD),
    potShare: POT_SHARE,
    devShare: 100 - POT_SHARE,
    eligibleCount: list.length,
    pending: amt(PENDING),
    totalPaid: state.rounds.reduce((s, r) => s + (r.txHash ? r.amount : 0), 0),
    pendingDraw: state.pendingDraw,
    lastBlock: state.lastBlock,
    rounds: state.rounds.slice(0, 25),
    rules: { minHoldPct: 0.1, weighting: "sqrt", drawDelayBlocks: DRAW_DELAY },
    explorer: CHAIN.explorer,
  };
}

const MIME = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".css": "text/css",
  ".js": "text/javascript",
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

http
  .createServer((req, res) => {
    const clean = (req.url || "/").split("?")[0];

    if (clean === "/api/state") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(JSON.stringify(publicState()));
    }

    if (clean !== "/" && !clean.includes("..")) {
      const asset = path.join(__dirname, "public", clean);
      if (fs.existsSync(asset) && fs.statSync(asset).isFile()) {
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(asset).toLowerCase()] || "application/octet-stream",
          "Cache-Control": "public, max-age=3600",
        });
        return res.end(fs.readFileSync(asset));
      }
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(__dirname, "public", "index.html")));
  })
  .listen(PORT, "0.0.0.0", () => console.log(`site en ecoute sur le port ${PORT}`));

// ---------------------------------------------------------------------------
// DEMARRAGE
// ---------------------------------------------------------------------------
async function main() {
  if (!TOKEN) {
    console.log("Mode pre-lancement : pas de TOKEN_ADDRESS.");
    console.log("Le site tourne, le bot attend le lancement du token.\n");
    return;
  }

  try {
    const net = await provider.getNetwork();
    console.log(`chainId ${net.chainId} ${Number(net.chainId) === CHAIN.id ? "(OK)" : `!! attendu ${CHAIN.id}`}`);
  } catch (e) {
    console.error("RPC injoignable:", e.shortMessage || e.message);
    console.error("Le site reste servi, le bot reessaiera au redemarrage.");
    return;
  }

  TOTAL_SUPPLY = await token.totalSupply();

  // Config du launch lue sur la factory Pons : la bonding curve est exclue
  // automatiquement, le pairing asset est controle, le destinataire des
  // fees aussi. Rien n'est devine.
  try {
    LAUNCH = await discoverLaunch(provider, TOKEN);
  } catch (e) {
    console.error("factory Pons illisible:", e.shortMessage || e.message);
  }
  if (LAUNCH) {
    const pair = LAUNCH.pairToken ? LAUNCH.pairToken.toLowerCase() : null;
    const cfg = PONS.feeAsset ? PONS.feeAsset.toLowerCase() : null;
    if (pair !== cfg) {
      CLAIM_BLOCKED = `pairing asset du launch = ${LAUNCH.pairToken || "ETH natif"} mais FEE_ASSET = ${PONS.feeAsset || "ETH natif"}`;
      console.error(`!! ${CLAIM_BLOCKED}`);
      console.error("!! Corrige FEE_ASSET / FEE_DECIMALS. Le bot ne reclame rien tant que ca ne colle pas.");
    }
    if (wallet && LAUNCH.creatorFeeRecipient.toLowerCase() !== wallet.address.toLowerCase()) {
      CLAIM_BLOCKED = `les fees vont a ${LAUNCH.creatorFeeRecipient}, pas au wallet du bot`;
      console.error(`!! ${CLAIM_BLOCKED}`);
      console.error("!! Lance le token depuis le wallet du bot, ou transfere le creatorFeeRecipient.");
    }
  } else {
    console.error("!! Ce token n'est pas un launch Pons V2 (factory.getLaunchedToken vide).");
  }

  if (!feeIsNative()) {
    try {
      FEE_SYMBOL = await new ethers.Contract(PONS.feeAsset, ERC20_ABI, provider).symbol();
    } catch {}
  }

  EXCLUDED = new Set(
    [...PONS.excluded, PONS.escrow, PONS.factory, LAUNCH?.curve, wallet?.address, ethers.ZeroAddress, "0x000000000000000000000000000000000000dEaD"]
      .filter(Boolean)
      .map((a) => a.toLowerCase())
  );

  console.log(`token     ${TOKEN}`);
  console.log(`supply    ${ethers.formatUnits(TOTAL_SUPPLY, 18)}`);
  console.log(`escrow    ${PONS.escrow || "(non configure — lance npm run probe)"}`);
  console.log(`bot       ${wallet?.address || "(lecture seule)"}`);
  console.log(`actif     ${feeIsNative() ? CHAIN.nativeSymbol + " natif" : FEE_SYMBOL + " " + PONS.feeAsset}`);
  console.log(`curve     ${LAUNCH?.curve || "(inconnue — exclusion manuelle via EXCLUDED)"}`);
  console.log(`launch    ${LAUNCH ? `creatorTaxBps=${LAUNCH.creatorTaxBps} protocolFeeShareBps=${LAUNCH.policy?.protocolFeeShareBps ?? "?"} phase=${LAUNCH.phase}` : "?"}`);
  console.log(`split     ${POT_SHARE}% pot / ${100 - POT_SHARE}% dev`);
  console.log(`seuil     ${amt(THRESHOLD)}`);
  console.log(`exclus    ${EXCLUDED.size} adresses`);
  console.log(`X         ${X.xEnabled() ? (process.env.X_DRY_RUN ? "dry-run" : "actif") : "desactive (pas de cles)"}\n`);

  if (!PONS.escrow) {
    console.log("ATTENTION : PONS_ESCROW n'est pas configure.");
    console.log("Le bot indexe les holders mais ne peut rien reclamer.\n");
  }

  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.error("tick KO:", e.shortMessage || e.message);
    }
    await new Promise((r) => setTimeout(r, TICK_SECONDS * 1000));
  }
}

// Un RPC injoignable au demarrage ne doit pas tuer le bot : on reessaie.
(async () => {
  for (;;) {
    try {
      await main();
      return;
    } catch (e) {
      console.error("demarrage KO, nouvel essai dans 10 s:", e.shortMessage || e.message);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
})();
