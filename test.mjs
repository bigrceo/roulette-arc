// Tests de la logique de tirage. Aucun réseau requis : node test.mjs
import { ethers } from "ethers";
import { isqrt, eligibleHolders, pickWinner, splitAmount, applyTransfer, TOTAL_SUPPLY } from "./lib.js";

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("  OK  " + m)) : (fail++, console.log("  KO  " + m)); };
const bal = (pct) => (TOTAL_SUPPLY * BigInt(Math.round(pct * 100))) / 10000n;

console.log("\n1. Racine carrée entière");
ok(isqrt(0n) === 0n && isqrt(1n) === 1n, "cas limites");
ok(isqrt(144n) === 12n, "144 -> 12");
ok(isqrt(10n ** 36n) === 10n ** 18n, "grands nombres (1e36 -> 1e18)");
ok(isqrt(99n) === 9n, "arrondi vers le bas");

console.log("\n2. Éligibilité");
{
  const balances = {
    "0xaaa": bal(40).toString(),
    "0xbbb": bal(5).toString(),
    "0xccc": bal(0.05).toString(),      // sous le minimum de 0,1%
    "0xlocker": bal(10).toString(),     // exclu
  };
  const { list } = eligibleHolders(balances, new Set(["0xlocker"]));
  ok(list.length === 2, "petits porteurs et contrats écartés");
  ok(!list.find(h => h.addr === "0xlocker"), "locker exclu");
  ok(!list.find(h => h.addr === "0xccc"), "sous le seuil exclu");
}

console.log("\n3. Ordre déterministe");
{
  const b1 = { "0xccc": bal(5).toString(), "0xaaa": bal(5).toString(), "0xbbb": bal(5).toString() };
  const b2 = { "0xbbb": bal(5).toString(), "0xccc": bal(5).toString(), "0xaaa": bal(5).toString() };
  const l1 = eligibleHolders(b1, new Set()).list.map(h => h.addr).join(",");
  const l2 = eligibleHolders(b2, new Set()).list.map(h => h.addr).join(",");
  ok(l1 === l2, "même liste quel que soit l'ordre d'insertion");
}

console.log("\n4. Reproductibilité du tirage");
{
  const balances = {};
  for (let i = 0; i < 12; i++) balances["0x" + String(i).padStart(40, "0")] = bal(2 + i).toString();
  const { list, total } = eligibleHolders(balances, new Set());
  const h = ethers.keccak256(ethers.toUtf8Bytes("bloc-cible"));
  const w1 = pickWinner(list, total, h), w2 = pickWinner(list, total, h);
  ok(w1.addr === w2.addr, "même hash -> même gagnant");
  const other = pickWinner(list, total, ethers.keccak256(ethers.toUtf8Bytes("autre")));
  ok(typeof other.addr === "string", "un autre hash donne un gagnant valide");
}

console.log("\n5. Distribution des chances");
{
  const balances = { "0xa": bal(60).toString(), "0xb": bal(10).toString(),
                     "0xc": bal(5).toString(), "0xd": bal(3).toString(), "0xe": bal(2).toString() };
  const { list, total } = eligibleHolders(balances, new Set());
  const c = {};
  for (let i = 0; i < 40000; i++) {
    const w = pickWinner(list, total, ethers.keccak256(ethers.toUtf8Bytes("s" + i)));
    c[w.addr] = (c[w.addr] || 0) + 1;
  }
  const whale = c["0xa"] / 400, small = c["0xe"] / 400;
  console.log(`     whale 60% -> ${whale.toFixed(1)}% des tirages | petit 2% -> ${small.toFixed(1)}%`);
  ok(whale > 40 && whale < 55, "la whale garde un avantage réel mais pas écrasant");
  ok(small > 5, "le petit porteur a une chance sérieuse");
  ok(whale < 60, "avantage strictement réduit vs pondération linéaire");
  const sum = Object.values(c).reduce((a, b) => a + b, 0);
  ok(sum === 40000, "un gagnant à chaque tirage, jamais zéro");
}

console.log("\n6. Découpe pot / créateur");
{
  const { pot, dev } = splitAmount(1_000_000n, 70);
  ok(pot === 700_000n && dev === 300_000n, "70/30 sur 1 USDC");
  const odd = splitAmount(999_999_999n, 70);
  ok(odd.pot + odd.dev === 999_999_999n, "aucun wei perdu à l'arrondi");
  const all = splitAmount(12345n, 100);
  ok(all.pot === 12345n && all.dev === 0n, "100% pot ne laisse rien au dev");
}

console.log("\n7. Comptabilité des soldes");
{
  const b = {}, Z = ethers.ZeroAddress;
  applyTransfer(b, Z, "0xAAA", 100n, Z);
  applyTransfer(b, "0xAAA", "0xBBB", 30n, Z);
  ok(b["0xaaa"] === "70" && b["0xbbb"] === "30", "transferts appliqués, casse normalisée");
  applyTransfer(b, "0xBBB", "0xAAA", 30n, Z);
  ok(b["0xbbb"] === undefined, "solde à zéro retiré du registre");
  applyTransfer(b, "0xAAA", Z, 100n, Z);
  ok(b["0xaaa"] === undefined, "burn vers l'adresse zéro géré");
}

console.log(`\n${pass} OK, ${fail} KO\n`);
process.exit(fail ? 1 : 0);
