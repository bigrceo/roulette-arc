import { ethers } from "ethers";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import {
  TOTAL_SUPPLY, MIN_HOLD_PCT, eligibleHolders, pickWinner,
  splitAmount, applyTransfer,
} from "./lib.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const RPC = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";
const PK = process.env.PRIVATE_KEY;
const TOKEN = (process.env.TOKEN_ADDRESS || "").toLowerCase();
const PORTAL = process.env.PORTAL_ADDRESS || "0xB021Be536808f551b31789422Fd28a6c9c6e97Da";
const DEPLOY_BLOCK = Number(process.env.DEPLOY_BLOCK || 0);
const POT_SHARE = Number(process.env.POT_SHARE || 70);
const THRESHOLD = Number(process.env.THRESHOLD_USDC || 50);
const DRAW_DELAY = Number(process.env.DRAW_DELAY_BLOCKS || 20);
const PORT = Number(process.env.PORT || 3000);
const TICK_SECONDS = Number(process.env.TICK_SECONDS || 30);

const USDC = "0x3600000000000000000000000000000000000000";
const USDC_DECIMALS = 6;
const EXPLORER = "https://explorer.arc.io";
const STATE_FILE = path.join(__dirname, "state.json");

// Règles du tirage — publiques, elles font partie du contrat social
// Les règles du tirage (éligibilité, pondération racine carrée, sélection)
// vivent dans lib.js, partagé avec verify.js.

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];
const PORTAL_ABI = [
  "function launches(address token) view returns (address creator, int24 tickStart, bool tokenIsToken0, address locker, address hook, address splitter, uint16 buyTaxBps, uint16 sellTaxBps, uint256 positionId, int24 tickBond, address quoteAsset)",
];
// claim() prend UNIQUEMENT le destinataire (confirme en sondant le Portal #7).
// Aucun getter fiable pour le montant en attente, donc on le mesure par la
// variation du solde USDC du wallet.
const SPLITTER_ABI = [
  "function claim(address to) external",
  "function creator() view returns (address)",
];

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = PK ? new ethers.Wallet(PK, provider) : null;
const token = new ethers.Contract(TOKEN, ERC20_ABI, provider);
const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet || provider);

let SPLITTER = null;
let EXCLUDED = new Set();

// ---------------------------------------------------------------------------
// ETAT
// ---------------------------------------------------------------------------
function freshState() {
  return {
    lastBlock: DEPLOY_BLOCK,
    balances: {},        // address -> balance en string (wei)
    potUsdc: "0",        // unités USDC brutes (6 décimales)
    devAccruedUsdc: "0",
    pendingDraw: null,   // { round, targetBlock, potUsdc, announcedAt }
    rounds: [],
  };
}
let state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
  : freshState();

function save() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
const fmt = (raw) => Number(ethers.formatUnits(raw, USDC_DECIMALS));

// ---------------------------------------------------------------------------
// INDEXATION DES HOLDERS
// Reconstruit les soldes depuis les events Transfer. Déterministe :
// n'importe qui peut refaire le même calcul et retomber sur les mêmes soldes.
// ---------------------------------------------------------------------------
async function syncBalances(upTo) {
  const iface = new ethers.Interface(ERC20_ABI);
  const topic = iface.getEvent("Transfer").topicHash;
  let from = state.lastBlock + 1;
  if (from > upTo) return;

  while (from <= upTo) {
    const to = Math.min(upTo, from + 3000);
    const logs = await provider.getLogs({
      address: TOKEN,
      topics: [topic],
      fromBlock: from,
      toBlock: to,
    });

    for (const log of logs) {
      const { args } = iface.parseLog(log);
      applyTransfer(state.balances, args.from, args.to, args.value, ethers.ZeroAddress);
    }

    state.lastBlock = to;
    from = to + 1;
    save();
  }
}

// ---------------------------------------------------------------------------
// CLAIM DES CREATOR FUNDS
// ---------------------------------------------------------------------------
async function claimFunds() {
  if (!wallet || !SPLITTER) return;
  const splitter = new ethers.Contract(SPLITTER, SPLITTER_ABI, wallet);

  try {
    await splitter.claim.staticCall(wallet.address);
  } catch {
    return;
  }

  let before;
  try {
    before = await usdc.balanceOf(wallet.address);
  } catch (e) {
    console.error("balanceOf KO:", e.message);
    return;
  }

  try {
    const tx = await splitter.claim(wallet.address);
    await tx.wait();
  } catch (e) {
    console.error("claim KO:", e.message);
    return;
  }

  const after = await usdc.balanceOf(wallet.address);
  const claimed = after - before;
  if (claimed <= 0n) {
    console.log("claim passe mais solde inchange");
    return;
  }

  const { pot: potPart, dev: devPart } = splitAmount(claimed, POT_SHARE);
  state.potUsdc = (BigInt(state.potUsdc) + potPart).toString();
  state.devAccruedUsdc = (BigInt(state.devAccruedUsdc) + devPart).toString();
  save();
  console.log(`claim ${fmt(claimed)} USDC  ->  pot +${fmt(potPart)} / dev +${fmt(devPart)}`);
}

// ---------------------------------------------------------------------------
// CYCLE DU ROUND
// ---------------------------------------------------------------------------
async function announceDrawIfReady(head) {
  if (state.pendingDraw) return;
  const pot = BigInt(state.potUsdc);
  if (fmt(pot) < THRESHOLD) return;

  state.pendingDraw = {
    round: state.rounds.length + 1,
    targetBlock: head + DRAW_DELAY,
    potUsdc: pot.toString(),
    announcedAt: new Date().toISOString(),
    announcedAtBlock: head,
  };
  save();
  console.log(
    `ROUND ${state.pendingDraw.round} annoncé — pot ${fmt(pot)} USDC, tirage au bloc ${state.pendingDraw.targetBlock}`
  );
}

async function executeDrawIfDue(head) {
  const d = state.pendingDraw;
  if (!d || head < d.targetBlock) return;

  // Soldes figés exactement au bloc du tirage → reproductible par quiconque
  await syncBalances(d.targetBlock);

  const block = await provider.getBlock(d.targetBlock);
  if (!block) {
    console.error("bloc cible introuvable, on retente");
    return;
  }

  const { list, total } = eligibleHolders(state.balances, EXCLUDED);
  if (!list.length) {
    console.log("aucun holder éligible, round reporté");
    state.pendingDraw = null;
    save();
    return;
  }

  const winner = pickWinner(list, total, block.hash);
  const amount = BigInt(d.potUsdc);

  let txHash = null,
    error = null;
  try {
    const tx = await usdc.transfer(winner.addr, amount);
    const r = await tx.wait();
    txHash = r.hash;
  } catch (e) {
    error = e.message;
    console.error("paiement KO:", e.message);
  }

  if (txHash) {
    state.potUsdc = (BigInt(state.potUsdc) - amount).toString();
  }

  state.rounds.unshift({
    round: d.round,
    at: new Date().toISOString(),
    targetBlock: d.targetBlock,
    blockHash: block.hash,
    winner: winner.addr,
    winnerWeightPct: Number((winner.weight * 10000n) / total) / 100,
    amountUsdc: fmt(amount),
    eligibleCount: list.length,
    txHash,
    error,
  });
  state.pendingDraw = null;
  save();

  console.log(
    `ROUND ${d.round} — ${fmt(amount)} USDC → ${winner.addr} (${txHash || "ECHEC"})`
  );
}

// ---------------------------------------------------------------------------
// BOUCLE
// ---------------------------------------------------------------------------
async function tick() {
  const head = await provider.getBlockNumber();
  await syncBalances(head);
  await claimFunds();
  await announceDrawIfReady(head);
  await executeDrawIfDue(head);
}

// ---------------------------------------------------------------------------
// SERVEUR WEB
// ---------------------------------------------------------------------------
function publicState() {
  const { list, total } = eligibleHolders(state.balances, EXCLUDED);
  return {
    token: TOKEN,
    splitter: SPLITTER,
    potUsdc: fmt(BigInt(state.potUsdc)),
    thresholdUsdc: THRESHOLD,
    potShare: POT_SHARE,
    devShare: 100 - POT_SHARE,
    eligibleCount: list.length,
    totalPaid: state.rounds.reduce((s, r) => s + (r.txHash ? r.amountUsdc : 0), 0),
    pendingDraw: state.pendingDraw,
    lastBlock: state.lastBlock,
    rounds: state.rounds.slice(0, 25),
    rules: {
      minHoldPct: MIN_HOLD_PCT * 100,
      weighting: "sqrt",
      drawDelayBlocks: DRAW_DELAY,
    },
    explorer: EXPLORER,
  };
}

http
  .createServer((req, res) => {
    if (req.url === "/api/state") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(JSON.stringify(publicState()));
    }
    const file = path.join(__dirname, "public", "index.html");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(file));
  })
  .listen(PORT, () => console.log(`site: http://localhost:${PORT}`));

// ---------------------------------------------------------------------------
// DEMARRAGE
// ---------------------------------------------------------------------------
async function main() {
  const net = await provider.getNetwork();
  console.log(`chainId ${net.chainId} (attendu 5042)`);
  if (!TOKEN) throw new Error("TOKEN_ADDRESS manquant");

  const portal = new ethers.Contract(PORTAL, PORTAL_ABI, provider);
  const rec = await portal.launches(TOKEN);
  SPLITTER = rec.splitter;

  // Adresses exclues du tirage : contrats du launch + wallet du bot
  EXCLUDED = new Set(
    [
      rec.locker,
      rec.hook,
      rec.splitter,
      PORTAL,
      "0x8366a39CC670B4001A1121B8F6A443A643e40951", // PoolManager
      "0x000000000000000000000000000000000000dEaD",
      wallet?.address,
    ]
      .filter(Boolean)
      .map((a) => a.toLowerCase())
  );

  console.log(`token    ${TOKEN}`);
  console.log(`creator  ${rec.creator}`);
  console.log(`splitter ${SPLITTER}`);
  console.log(`bot      ${wallet?.address || "(lecture seule)"}`);
  if (wallet && rec.creator.toLowerCase() !== wallet.address.toLowerCase()) {
    console.warn("ATTENTION: le wallet du bot n'est pas le creator — claim() échouera.");
  }
  console.log(`split    ${POT_SHARE}% pot / ${100 - POT_SHARE}% dev`);
  console.log(`seuil    ${THRESHOLD} USDC\n`);

  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.error("tick KO:", e.message);
    }
    await new Promise((r) => setTimeout(r, TICK_SECONDS * 1000));
  }
}

main();
