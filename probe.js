// ===========================================================================
//  Sonde un token Pons sur Robinhood Chain. LECTURE SEULE : aucune
//  transaction, aucune cle privee.
//
//    TOKEN_ADDRESS=0x… npm run probe
//
//  Sortie : le reseau, le temps de bloc reel, les contrats lies au token,
//  les holders a exclure, et la signature de retrait des fees qui existe
//  reellement. Le bloc de config a recopier dans chain.js est imprime a la fin.
//
//  Methode : on ne fait pas confiance a la doc. On appelle chaque fonction
//  candidate en staticCall et on regarde laquelle repond. Une fonction
//  absente renvoie "missing revert data". Une fonction presente qui refuse
//  renvoie une vraie erreur d'execution. C'est la difference qui nous
//  interesse.
// ===========================================================================

import { ethers } from "ethers";
import {
  CHAIN,
  PONS,
  ERC20_ABI,
  CLAIM_CANDIDATES,
  PENDING_CANDIDATES,
  CREATOR_CANDIDATES,
  discoverLaunch,
} from "./chain.js";

const TOKEN = (process.env.TOKEN_ADDRESS || "").toLowerCase();
let FROM = process.env.FROM_ADDRESS || null; // wallet createur, si connu

if (!TOKEN) {
  console.error("usage: TOKEN_ADDRESS=0x… npm run probe");
  console.error("       (optionnel) FROM_ADDRESS=0x… pour tester les droits");
  process.exit(1);
}

const p = new ethers.JsonRpcProvider(CHAIN.rpc, CHAIN.id, {
  staticNetwork: true,
});
const line = (n = 70) => "─".repeat(n);
const pad = (s, n) => String(s).padEnd(n);
const fmt = (v, d = 18) => Number(ethers.formatUnits(v, d)).toLocaleString("en-US", { maximumFractionDigits: 6 });

// ---------------------------------------------------------------------------
// 1. Reseau
// ---------------------------------------------------------------------------
const net = await p.getNetwork();
const head = await p.getBlockNumber();

console.log(`
  PONS LAUNCH PROBE                          read-only, no key required
  ${line()}
  rpc        ${CHAIN.rpc}
  chain id   ${net.chainId} ${Number(net.chainId) === CHAIN.id ? "✓" : `✗ attendu ${CHAIN.id}`}
  head       ${head}
  token      ${TOKEN}`);

// Temps de bloc reel — determinant sur un L2, ou les blocs sont rapides
let blockTime = null;
try {
  const SPAN = 2000;
  const [a, b] = await Promise.all([
    p.getBlock(Math.max(1, head - SPAN)),
    p.getBlock(head),
  ]);
  if (a && b && b.number > a.number) {
    blockTime = (b.timestamp - a.timestamp) / (b.number - a.number);
    const perMin = blockTime > 0 ? Math.round(60 / blockTime) : 0;
    console.log(`  block time ${blockTime.toFixed(3)}s  (~${perMin} blocs/min)`);
    console.log(`  → pour ~3 min d'annonce : DRAW_DELAY_BLOCKS=${perMin * 3}`);
  }
} catch (e) {
  console.log(`  block time  non mesurable (${e.shortMessage || e.message})`);
}

// ---------------------------------------------------------------------------
// 2. Le token
// ---------------------------------------------------------------------------
const token = new ethers.Contract(TOKEN, ERC20_ABI, p);
let supply = null,
  decimals = 18,
  symbol = "?";
try {
  [symbol, decimals, supply] = await Promise.all([
    token.symbol().catch(() => "?"),
    token.decimals().catch(() => 18),
    token.totalSupply(),
  ]);
  decimals = Number(decimals);
  console.log(`
  TOKEN
  ${line()}
  symbol     ${symbol}
  decimals   ${decimals}
  supply     ${fmt(supply, decimals)}`);
} catch (e) {
  console.log(`\n  ✗ Le token ne repond pas comme un ERC20 : ${e.shortMessage || e.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2b. La factory Pons V2 : ce qu'elle dit du launch
// ---------------------------------------------------------------------------
let launch = null;
try {
  launch = await discoverLaunch(p, TOKEN);
} catch (e) {
  console.log(`  factory   ${PONS.factory} ne repond pas (${e.shortMessage || e.message})`);
}
if (launch) {
  console.log(`
  LAUNCH PONS V2                             lu sur la factory ${PONS.factory}
  ${line()}
  curve      ${launch.curve}   (bonding curve — a exclure)
  deployer   ${launch.deployer}
  fees a     ${launch.creatorFeeRecipient}   (creatorFeeRecipient — doit etre le wallet du bot)
  pairing    ${launch.pairToken || "ETH natif"}
  taxe       creatorTaxBps=${launch.creatorTaxBps}  protocolFeeShareBps=${launch.policy?.protocolFeeShareBps ?? "?"}  hookFeeBps=${launch.policy?.hookFeeBps ?? "?"}
  phase      ${launch.phase} (${launch.phase === 2 ? "gradue" : "sur la curve"})`);
} else {
  console.log(`
  ✗ Pas un launch Pons V2 : factory.getLaunchedToken() est vide.`);
}

// ---------------------------------------------------------------------------
// 3. Rejouer les Transfer : qui a mint, qui detient quoi
// ---------------------------------------------------------------------------
const iface = new ethers.Interface(ERC20_ABI);
const topic = iface.getEvent("Transfer").topicHash;

// On remonte par fenetres jusqu'a trouver le premier mint (from = 0x0)
const balances = {};
let firstMintTo = null,
  firstBlock = null,
  logCount = 0;

const CHUNK = 5000;
const LOOKBACK = Number(process.env.LOOKBACK_BLOCKS || 400_000);
const start = Math.max(0, head - LOOKBACK);

process.stdout.write(`\n  indexation des transferts depuis le bloc ${start} `);
for (let from = start; from <= head; from += CHUNK) {
  const to = Math.min(head, from + CHUNK - 1);
  let logs;
  try {
    logs = await p.getLogs({ address: TOKEN, topics: [topic], fromBlock: from, toBlock: to });
  } catch {
    process.stdout.write("!");
    continue;
  }
  for (const l of logs) {
    const { args } = iface.parseLog(l);
    const f = args.from.toLowerCase(),
      t = args.to.toLowerCase();
    if (f === ethers.ZeroAddress.toLowerCase() && !firstMintTo) {
      firstMintTo = t;
      firstBlock = l.blockNumber;
    }
    if (f !== ethers.ZeroAddress.toLowerCase()) {
      const cur = BigInt(balances[f] || "0") - args.value;
      if (cur <= 0n) delete balances[f];
      else balances[f] = cur.toString();
    }
    if (t !== ethers.ZeroAddress.toLowerCase()) {
      balances[t] = (BigInt(balances[t] || "0") + args.value).toString();
    }
    logCount++;
  }
  if ((from - start) % (CHUNK * 20) === 0) process.stdout.write(".");
}
console.log(` ${logCount} transferts`);

if (firstBlock) {
  console.log(`  premier mint au bloc ${firstBlock} → DEPLOY_BLOCK=${firstBlock}`);
}

// ---------------------------------------------------------------------------
// 4. Top holders — candidats a l'exclusion
// ---------------------------------------------------------------------------
const holders = Object.entries(balances)
  .map(([addr, bal]) => ({ addr, bal: BigInt(bal) }))
  .sort((a, b) => (b.bal > a.bal ? 1 : -1));

console.log(`
  TOP HOLDERS                                les contrats sont a exclure
  ${line()}`);

const contractFlags = [];
for (const h of holders.slice(0, 12)) {
  const pct = supply > 0n ? Number((h.bal * 10000n) / supply) / 100 : 0;
  let kind = "wallet";
  try {
    const code = await p.getCode(h.addr);
    if (code && code !== "0x") {
      kind = "CONTRAT";
      contractFlags.push(h.addr);
    }
  } catch {}
  console.log(`  ${pad(h.addr, 44)} ${pad(pct.toFixed(2) + "%", 9)} ${kind}`);
}

if (firstMintTo && !contractFlags.includes(firstMintTo)) contractFlags.push(firstMintTo);
if (launch && !contractFlags.includes(launch.curve.toLowerCase())) contractFlags.push(launch.curve.toLowerCase());

console.log(`
  → ${contractFlags.length} contrat(s) detiennent des tokens. Sur Pons V2 la
    bonding curve en fait partie : s'ils ne sont pas exclus, ils gagnent
    les tirages.`);

if (!FROM && launch) FROM = launch.creatorFeeRecipient; // on teste avec le vrai destinataire

// ---------------------------------------------------------------------------
// 5. Chercher l'escrow des fees
// ---------------------------------------------------------------------------
// Candidats : les contrats qui detiennent des tokens, le destinataire du
// premier mint, et toute adresse fournie via PONS_ESCROW / PONS_FACTORY.
const targets = [
  ...new Set(
    [...contractFlags, firstMintTo, PONS.escrow, PONS.factory]
      .filter(Boolean)
      .map((a) => a.toLowerCase())
  ),
];

console.log(`
  RECHERCHE DE L'ESCROW                      ${targets.length} contrat(s) testes
  ${line()}`);

const found = [];
for (const addr of targets) {
  const hits = [];

  // qui est designe comme createur / proprietaire ?
  for (const sig of CREATOR_CANDIDATES) {
    const fn = sig.match(/function (\w+)/)[1];
    try {
      const v = await new ethers.Contract(addr, [sig], p)[fn]();
      if (v && v !== ethers.ZeroAddress) hits.push(`${fn}() = ${v}`);
    } catch {}
  }

  // y a-t-il un montant en attente lisible ?
  const who = FROM || (hits.length ? hits[0].split("= ")[1] : null);
  if (who) {
    for (const sig of PENDING_CANDIDATES) {
      const fn = sig.match(/function (\w+)/)[1];
      try {
        const v = await new ethers.Contract(addr, [sig], p)[fn](who);
        if (v !== undefined && v !== null) hits.push(`${fn}(creator) = ${v}`);
      } catch {}
    }
  }

  if (hits.length) {
    console.log(`\n  ${addr}`);
    for (const h of hits) console.log(`    ✓ ${h}`);
    found.push({ addr, hits });
  }
}
if (!found.length) {
  console.log(`
  Aucun getter reconnu sur ces contrats.
  L'escrow Pons est peut-etre une adresse globale distincte. Recupere-la
  depuis l'explorer (une tx de retrait de fees d'un autre createur) et
  relance avec PONS_ESCROW=0x…`);
}

// ---------------------------------------------------------------------------
// 6. Signature de retrait — le point qui debloque le bot
// ---------------------------------------------------------------------------
console.log(`
  SIGNATURE DE RETRAIT                       simule, rien n'est envoye
  ${line()}`);

const claimTargets = found.length ? found.map((f) => f.addr) : targets;
const working = [];

for (const addr of claimTargets) {
  const caller = FROM || undefined;
  let printed = false;
  for (const cand of CLAIM_CANDIDATES) {
    const fn = cand.sig.match(/function (\w+)/)[1];
    const args = cand.args(caller || ethers.ZeroAddress, TOKEN, launch?.pairToken || PONS.feeAsset || ethers.ZeroAddress);
    const c = new ethers.Contract(addr, [cand.sig], p);
    let verdict = null;
    try {
      await c[fn].staticCall(...args, caller ? { from: caller } : {});
      verdict = "✓ existe et passe";
      working.push({ addr, sig: cand.sig, state: "callable" });
    } catch (e) {
      const m = String(e.shortMessage || e.message || "");
      if (m.includes("missing revert data") || m.includes("no data present")) {
        // fonction absente : on ne l'affiche pas, ca noierait la sortie
      } else {
        verdict = `✓ existe (revert : ${m.slice(0, 44)})`;
        working.push({ addr, sig: cand.sig, state: "exists" });
      }
    }
    if (verdict) {
      if (!printed) {
        console.log(`\n  ${addr}`);
        printed = true;
      }
      console.log(`    ${pad(cand.sig.replace("function ", "").replace(" external", ""), 40)} ${verdict}`);
    }
  }
}

if (!working.length) {
  console.log(`
  Aucune signature candidate ne repond.
  Deux pistes :
   1. l'escrow n'est pas dans la liste testee — trouve-le sur l'explorer
   2. le nom de la fonction n'est pas couvert — ajoute-le dans
      CLAIM_CANDIDATES de chain.js et relance`);
}

// ---------------------------------------------------------------------------
// 7. Config prete a coller
// ---------------------------------------------------------------------------
const best = working.find((w) => w.state === "callable") || working[0];
const perMin = blockTime > 0 ? Math.round(60 / blockTime) : 600;

console.log(`

  A RECOPIER DANS chain.js / .env
  ${line()}
  TOKEN_ADDRESS=${TOKEN}
  DEPLOY_BLOCK=${firstBlock || "?"}
  DRAW_DELAY_BLOCKS=${perMin * 3}
  EXCLUDED=${contractFlags.join(",") || "?"}
  PONS_ESCROW=${best ? best.addr : "?"}
  FEE_ASSET=${launch?.pairToken || "(vide : ETH natif)"}
  FEE_DECIMALS=${launch?.pairToken ? await new ethers.Contract(launch.pairToken, ERC20_ABI, p).decimals().catch(() => "?") : 18}
${best ? `  signature retenue : ${best.sig}` : "  signature : non trouvee, voir ci-dessus"}
  ${line()}
`);
