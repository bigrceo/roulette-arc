// Inspect any Argus launch on Arc. Read-only — no private key, no transaction.
//   TOKEN_ADDRESS=0x… node probe.js
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

const p = new ethers.JsonRpcProvider(RPC, 5042, { staticNetwork: true });
const pad = (s, n) => String(s).padEnd(n);
const net = await p.getNetwork();

console.log(`
  ARGUS LAUNCH PROBE                         read-only, no key required
  ${"─".repeat(68)}
  rpc        ${RPC}
  chain id   ${net.chainId} ${Number(net.chainId) === 5042 ? "✓" : "✗ expected 5042"}
  block      ${await p.getBlockNumber()}
  token      ${TOKEN}
`);

const LAUNCH_ABI = ["function launches(address) view returns (address creator, int24 tickStart, bool tokenIsToken0, address locker, address hook, address splitter, uint16 buyTaxBps, uint16 sellTaxBps, uint256 positionId, int24 tickBond, address quoteAsset)"];

let rec = null, portal = null;
for (const [name, addr] of PORTALS) {
  try {
    const r = await new ethers.Contract(addr, LAUNCH_ABI, p).launches(TOKEN);
    if (r.creator !== ethers.ZeroAddress) { rec = r; portal = [name, addr]; break; }
  } catch {}
}
if (!rec) { console.log("  No portal recognises this token with the documented ABI.\n"); process.exit(1); }

console.log(`  LAUNCH RECORD                              portal ${portal[0]}
  ${"─".repeat(68)}
  creator    ${rec.creator}
  splitter   ${rec.splitter}
  hook       ${rec.hook}
  locker     ${rec.locker}
  tax        ${Number(rec.buyTaxBps)/100}% buy  /  ${Number(rec.sellTaxBps)/100}% sell
  quote      ${rec.quoteAsset === USDC ? "USDC" : rec.quoteAsset}

  launches(address) → ABI matches the public repo ✓
`);

const tests = [
  ["creditedToCreator(address)", "function creditedToCreator(address) view returns (uint256)", "creditedToCreator", [USDC]],
  ["creatorFundsBps()", "function creatorFundsBps() view returns (uint16)", "creatorFundsBps", []],
  ["buybackBurnBps()", "function buybackBurnBps() view returns (uint16)", "buybackBurnBps", []],
  ["dividendsBps()", "function dividendsBps() view returns (uint16)", "dividendsBps", []],
  ["liquidityBps()", "function liquidityBps() view returns (uint16)", "liquidityBps", []],
  ["creator()", "function creator() view returns (address)", "creator", []],
];

console.log(`  REVENUE SPLITTER                           which getters actually exist
  ${"─".repeat(68)}`);
for (const [label, abi, fn, args] of tests) {
  try {
    const v = await new ethers.Contract(rec.splitter, [abi], p)[fn](...args);
    console.log(`  ✓  ${pad(label, 28)} ${v}`);
  } catch {
    console.log(`  ✗  ${pad(label, 28)} not present under this name`);
  }
}

console.log(`
  CLAIM SIGNATURE                            simulated, nothing is sent
  ${"─".repeat(68)}`);
const variants = [
  ["claim(address,address)", "function claim(address to, address quoteAsset)", [rec.creator, USDC]],
  ["claim(address)", "function claim(address to)", [rec.creator]],
  ["claim()", "function claim()", []],
];
for (const [label, sig, args] of variants) {
  const c = new ethers.Contract(rec.splitter, [sig], p);
  const fn = label.split("(")[0];
  let verdict;
  try {
    await c[fn].staticCall(...args, { from: rec.creator });
    verdict = "✓  exists, callable";
  } catch (e) {
    const m = String(e.shortMessage || e.message);
    verdict = m.includes("missing revert data")
      ? "✗  no such function"
      : "✓  exists (reverted — nothing to claim or not authorised)";
  }
  console.log(`  ${pad(label, 28)} ${verdict}`);
}

console.log(`
  ${"─".repeat(68)}
  The deployed portal does not match the public repo one-for-one.
  Probe before you trust the docs.

  github.com/bigrceo/roulette-arc
`);
