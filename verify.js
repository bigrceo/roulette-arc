// Vérification indépendante d'un round.
//   node verify.js <numéro de round>
//
// Recalcule le gagnant depuis la blockchain et le compare à celui annoncé.
// Utilise exactement la même logique que le bot (lib.js), donc les deux ne
// peuvent pas diverger.
import { ethers } from "ethers";
import fs from "fs";
import { eligibleHolders, pickWinner, applyTransfer } from "./lib.js";

const RPC = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";
const TOKEN = (process.env.TOKEN_ADDRESS || "").toLowerCase();
const DEPLOY_BLOCK = Number(process.env.DEPLOY_BLOCK || 0);
const EXCLUDED = new Set(
  (process.env.EXCLUDED || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean)
);

const round = Number(process.argv[2]);
if (!TOKEN || !round) {
  console.error("usage: TOKEN_ADDRESS=0x… DEPLOY_BLOCK=… EXCLUDED=0x…,0x… node verify.js <round>");
  process.exit(1);
}

const rec = JSON.parse(fs.readFileSync("./state.json", "utf8")).rounds.find(r => r.round === round);
if (!rec) { console.error("round introuvable dans state.json"); process.exit(1); }

const provider = new ethers.JsonRpcProvider(RPC);
const iface = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const topic = iface.getEvent("Transfer").topicHash;

console.log(`Round ${round} — rejeu des soldes jusqu'au bloc ${rec.targetBlock}…`);

const balances = {};
for (let from = DEPLOY_BLOCK; from <= rec.targetBlock; from += 3000) {
  const to = Math.min(rec.targetBlock, from + 2999);
  const logs = await provider.getLogs({ address: TOKEN, topics: [topic], fromBlock: from, toBlock: to });
  for (const l of logs) {
    const { args } = iface.parseLog(l);
    applyTransfer(balances, args.from, args.to, args.value, ethers.ZeroAddress);
  }
}

const { list, total } = eligibleHolders(balances, EXCLUDED);
const block = await provider.getBlock(rec.targetBlock);
const winner = pickWinner(list, total, block.hash);

const hashOk = block.hash === rec.blockHash;
const winOk = winner && winner.addr === rec.winner;

console.log(`
  holders éligibles  ${list.length}  (annoncé: ${rec.eligibleCount})
  hash du bloc       ${block.hash}
  hash annoncé       ${rec.blockHash}   ${hashOk ? "OK" : "DIVERGENCE"}
  gagnant recalculé  ${winner?.addr}
  gagnant annoncé    ${rec.winner}   ${winOk ? "OK" : "DIVERGENCE"}
  montant            ${rec.amountUsdc} USDC
  paiement           ${rec.txHash || "aucun"}
`);
process.exit(hashOk && winOk ? 0 : 1);
