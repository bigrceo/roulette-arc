// ===========================================================================
//  Verification independante d'un round.
//
//    TOKEN_ADDRESS=0x… DEPLOY_BLOCK=… EXCLUDED=0x…,0x… node verify.js 3
//
//  Rejoue chaque event Transfer jusqu'au bloc du tirage, reconstruit les
//  soldes, relit le hash du bloc sur la chaine, recalcule le gagnant, et
//  compare a ce qui a ete publie.
//
//  Ce script importe le MEME lib.js que le bot : les deux ne peuvent pas
//  diverger. C'est ce qui rend la verification utile plutot que decorative.
// ===========================================================================

import { ethers } from "ethers";
import fs from "fs";
import { CHAIN, ERC20_ABI, PONS, discoverLaunch } from "./chain.js";
import { eligibleHolders, pickWinner, applyTransfer } from "./lib.js";

const TOKEN = (process.env.TOKEN_ADDRESS || "").toLowerCase();
const DEPLOY_BLOCK = Number(process.env.DEPLOY_BLOCK || 0);
const EXCLUDED = new Set(
  [...PONS.excluded, ...(process.env.EXCLUDED || "").split(",")]
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const round = Number(process.argv[2]);
if (!TOKEN || !round) {
  console.error("usage: TOKEN_ADDRESS=0x… DEPLOY_BLOCK=… node verify.js <round>");
  process.exit(1);
}

const file = process.env.STATE_FILE || "./state.json";
const rec = JSON.parse(fs.readFileSync(file, "utf8")).rounds.find((r) => r.round === round);
if (!rec) {
  console.error(`round ${round} introuvable dans ${file}`);
  process.exit(1);
}

const p = new ethers.JsonRpcProvider(CHAIN.rpc, CHAIN.id, { staticNetwork: true });

// Meme regle que le bot : la bonding curve et le destinataire des fees
// (le wallet du bot) sont lus sur la factory Pons et exclus.
try {
  const launch = await discoverLaunch(p, TOKEN);
  if (launch) {
    EXCLUDED.add(launch.curve.toLowerCase());
    EXCLUDED.add(launch.creatorFeeRecipient.toLowerCase());
    console.log(`curve ${launch.curve} et fees ${launch.creatorFeeRecipient} exclus (factory Pons)`);
  }
} catch (e) {
  console.log(`factory Pons illisible (${e.shortMessage || e.message}) — passe la curve via EXCLUDED`);
}
EXCLUDED.add(ethers.ZeroAddress);
EXCLUDED.add("0x000000000000000000000000000000000000dead");

const iface = new ethers.Interface(ERC20_ABI);
const topic = iface.getEvent("Transfer").topicHash;

console.log(`Round ${round} — rejeu des soldes jusqu'au bloc ${rec.targetBlock}…`);

const balances = {};
for (let from = DEPLOY_BLOCK; from <= rec.targetBlock; from += 3000) {
  const to = Math.min(rec.targetBlock, from + 2999);
  const logs = await p.getLogs({ address: TOKEN, topics: [topic], fromBlock: from, toBlock: to });
  for (const l of logs) {
    const { args } = iface.parseLog(l);
    applyTransfer(balances, args.from, args.to, args.value, ethers.ZeroAddress.toLowerCase());
  }
}

const supply = await new ethers.Contract(TOKEN, ERC20_ABI, p).totalSupply();
const { list, total } = eligibleHolders(balances, EXCLUDED, supply);
const block = await p.getBlock(rec.targetBlock);
const winner = pickWinner(list, total, block.hash);

const hashOk = block.hash === rec.blockHash;
const winOk = winner && winner.addr === rec.winner;

console.log(`
  holders eligibles  ${list.length}  (publie : ${rec.eligibleCount})
  hash du bloc       ${block.hash}
  hash publie        ${rec.blockHash}   ${hashOk ? "OK" : "DIVERGENCE"}
  gagnant recalcule  ${winner?.addr}
  gagnant publie     ${rec.winner}   ${winOk ? "OK" : "DIVERGENCE"}
  montant            ${rec.amount}
  paiement           ${rec.txHash ? CHAIN.explorer + "/tx/" + rec.txHash : "aucun"}
`);

process.exit(hashOk && winOk ? 0 : 1);
