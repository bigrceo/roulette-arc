// Sonde l'ABI réelle d'Argus contre un token déjà lancé, en LECTURE SEULE.
// Aucune transaction, aucune clé privée requise.
//   TOKEN_ADDRESS=0xTonToken node probe.js
import { ethers } from "ethers";

const RPC = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";
const TOKEN = process.env.TOKEN_ADDRESS;
const USDC = "0x3600000000000000000000000000000000000000";

const PORTALS = [
  ["#7", "0xB021Be536808f551b31789422Fd28a6c9c6e97Da"],
  ["#6", "0xA5628A11c412596E1f63b75a2C0284F843C549d6"],
  ["#5", "0x07a688a001f416cC433c68Ff56Aa26bC5131Cc6E"],
  ["#4", "0xa36c443A797771Df82533B8B4A86F0AFfd970862"],
  ["#3", "0x7A17Ab0106C46C0be30623F3EB7F299CC0058338"],
];

if (!TOKEN) { console.error("usage: TOKEN_ADDRESS=0x… node probe.js"); process.exit(1); }
const p = new ethers.JsonRpcProvider(RPC);

const net = await p.getNetwork();
console.log(`RPC      ${RPC}`);
console.log(`chainId  ${net.chainId} ${Number(net.chainId) === 5042 ? "OK" : "!! attendu 5042"}`);
console.log(`bloc     ${await p.getBlockNumber()}`);
console.log(`token    ${TOKEN}\n`);

// 1. Quel Portal connaît ce token ?
const LAUNCH_ABI = ["function launches(address) view returns (address creator, int24 tickStart, bool tokenIsToken0, address locker, address hook, address splitter, uint16 buyTaxBps, uint16 sellTaxBps, uint256 positionId, int24 tickBond, address quoteAsset)"];
let rec = null, portalUsed = null;
for (const [name, addr] of PORTALS) {
  try {
    const r = await new ethers.Contract(addr, LAUNCH_ABI, p).launches(TOKEN);
    if (r.creator !== ethers.ZeroAddress) { rec = r; portalUsed = [name, addr]; break; }
  } catch { /* ABI incompatible avec ce Portal, on continue */ }
}

if (!rec) {
  console.log("Aucun Portal ne reconnaît ce token avec l'ABI testée.");
  console.log("=> soit le token n'est pas d'Argus, soit la signature de launches() diffère.");
  process.exit(1);
}

console.log(`Portal      ${portalUsed[0]}  ${portalUsed[1]}`);
console.log(`  creator   ${rec.creator}`);
console.log(`  splitter  ${rec.splitter}`);
console.log(`  hook      ${rec.hook}`);
console.log(`  locker    ${rec.locker}`);
console.log(`  taxes     ${Number(rec.buyTaxBps)/100}% buy / ${Number(rec.sellTaxBps)/100}% sell`);
console.log(`  quote     ${rec.quoteAsset}`);
console.log(`  -> launches() : ABI CONFIRMEE\n`);

// 2. Le splitter expose-t-il bien ce qu'on attend ?
const tests = [
  ["creditedToCreator(address)", ["function creditedToCreator(address) view returns (uint256)"], "creditedToCreator", [USDC]],
  ["creatorFundsBps()",  ["function creatorFundsBps() view returns (uint16)"],  "creatorFundsBps",  []],
  ["buybackBurnBps()",   ["function buybackBurnBps() view returns (uint16)"],   "buybackBurnBps",   []],
  ["dividendsBps()",     ["function dividendsBps() view returns (uint16)"],     "dividendsBps",     []],
  ["liquidityBps()",     ["function liquidityBps() view returns (uint16)"],     "liquidityBps",     []],
  ["creator()",          ["function creator() view returns (address)"],         "creator",          []],
];
console.log(`Splitter ${rec.splitter}`);
for (const [label, abi, fn, args] of tests) {
  try {
    const v = await new ethers.Contract(rec.splitter, abi, p)[fn](...args);
    console.log(`  OK  ${label.padEnd(26)} = ${v}`);
  } catch (e) {
    console.log(`  KO  ${label.padEnd(26)} ${String(e.shortMessage || e.message).slice(0, 70)}`);
  }
}

// 3. claim() : qui peut l'appeler, et avec quelle signature ?
console.log(`\nclaim() — test de signature (simulation, aucune tx envoyée)`);
const variants = [
  ["claim(address,address)", "function claim(address to, address quoteAsset)", [rec.creator, USDC]],
  ["claim(address)",         "function claim(address to)",                     [rec.creator]],
  ["claim()",                "function claim()",                               []],
];
for (const [label, sig, args] of variants) {
  const c = new ethers.Contract(rec.splitter, [sig], p);
  const fn = label.split("(")[0];
  // depuis le creator
  let asCreator = "—", asAnyone = "—";
  try { await c[fn].staticCall(...args, { from: rec.creator }); asCreator = "passe"; }
  catch (e) { asCreator = String(e.shortMessage || e.message).slice(0, 46); }
  try { await c[fn].staticCall(...args, { from: "0x000000000000000000000000000000000000dEaD" }); asAnyone = "passe"; }
  catch (e) { asAnyone = String(e.shortMessage || e.message).slice(0, 46); }
  console.log(`  ${label}`);
  console.log(`     depuis le creator : ${asCreator}`);
  console.log(`     depuis un tiers   : ${asAnyone}`);
}
