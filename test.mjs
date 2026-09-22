// ===========================================================================
//  Tests de la logique de tirage. Aucun reseau requis : npm test
// ===========================================================================

import { ethers } from "ethers";
import { isqrt, eligibleHolders, pickWinner, splitAmount, applyTransfer, reconcileBalance } from "./lib.js";

const SUPPLY = 1_000_000_000n * 10n ** 18n;
let pass = 0,
  fail = 0;
const ok = (c, m) => {
  c ? (pass++, console.log("  OK  " + m)) : (fail++, console.log("  KO  " + m));
};
const bal = (pct) => (SUPPLY * BigInt(Math.round(pct * 100))) / 10000n;

console.log("\n1. Racine carree entiere");
ok(isqrt(0n) === 0n && isqrt(1n) === 1n, "cas limites");
ok(isqrt(144n) === 12n, "144 -> 12");
ok(isqrt(10n ** 36n) === 10n ** 18n, "grands nombres (1e36 -> 1e18)");
ok(isqrt(99n) === 9n, "arrondi vers le bas");

console.log("\n2. Eligibilite");
{
  const balances = {
    "0xaaa": bal(40).toString(),
    "0xbbb": bal(5).toString(),
    "0xccc": bal(0.05).toString(), // sous le minimum de 0,1%
    "0xcurve": bal(10).toString(), // bonding curve : exclue
  };
  const { list } = eligibleHolders(balances, new Set(["0xcurve"]), SUPPLY);
  ok(list.length === 2, "petits porteurs et contrats ecartes");
  ok(!list.find((h) => h.addr === "0xcurve"), "bonding curve exclue");
  ok(!list.find((h) => h.addr === "0xccc"), "sous le seuil exclu");
}

console.log("\n3. Ordre deterministe");
{
  const b1 = { "0xccc": bal(5).toString(), "0xaaa": bal(5).toString(), "0xbbb": bal(5).toString() };
  const b2 = { "0xbbb": bal(5).toString(), "0xccc": bal(5).toString(), "0xaaa": bal(5).toString() };
  const l1 = eligibleHolders(b1, new Set(), SUPPLY).list.map((h) => h.addr).join(",");
  const l2 = eligibleHolders(b2, new Set(), SUPPLY).list.map((h) => h.addr).join(",");
  ok(l1 === l2, "meme liste quel que soit l'ordre d'insertion");
}

console.log("\n4. Reproductibilite du tirage");
{
  const balances = {};
  for (let i = 0; i < 12; i++) balances["0x" + String(i).padStart(40, "0")] = bal(2 + i).toString();
  const { list, total } = eligibleHolders(balances, new Set(), SUPPLY);
  const h = ethers.keccak256(ethers.toUtf8Bytes("bloc-cible"));
  ok(pickWinner(list, total, h).addr === pickWinner(list, total, h).addr, "meme hash -> meme gagnant");
  ok(typeof pickWinner(list, total, ethers.keccak256(ethers.toUtf8Bytes("autre"))).addr === "string",
     "un autre hash donne un gagnant valide");
}

console.log("\n5. Distribution des chances");
{
  const balances = {
    "0xa": bal(60).toString(),
    "0xb": bal(10).toString(),
    "0xc": bal(5).toString(),
    "0xd": bal(3).toString(),
    "0xe": bal(2).toString(),
  };
  const { list, total } = eligibleHolders(balances, new Set(), SUPPLY);
  const c = {};
  for (let i = 0; i < 40000; i++) {
    const w = pickWinner(list, total, ethers.keccak256(ethers.toUtf8Bytes("s" + i)));
    c[w.addr] = (c[w.addr] || 0) + 1;
  }
  const whale = c["0xa"] / 400,
    small = c["0xe"] / 400;
  console.log(`     whale 60% -> ${whale.toFixed(1)}% des tirages | petit 2% -> ${small.toFixed(1)}%`);
  ok(whale > 40 && whale < 55, "la whale garde un avantage reel mais pas ecrasant");
  ok(small > 5, "le petit porteur a une chance serieuse");
  ok(whale < 60, "avantage strictement reduit vs ponderation lineaire");
  ok(Object.values(c).reduce((a, b) => a + b, 0) === 40000, "un gagnant a chaque tirage");
}

console.log("\n6. Decoupe pot / createur");
{
  const { pot, dev } = splitAmount(1_000_000n, 70);
  ok(pot === 700_000n && dev === 300_000n, "70/30");
  const odd = splitAmount(999_999_999n, 70);
  ok(odd.pot + odd.dev === 999_999_999n, "aucune unite perdue a l'arrondi");
  const all = splitAmount(12345n, 100);
  ok(all.pot === 12345n && all.dev === 0n, "100% pot ne laisse rien au dev");
}

console.log("\n7. Comptabilite des soldes");
{
  const b = {},
    Z = ethers.ZeroAddress.toLowerCase();
  applyTransfer(b, Z, "0xAAA", 100n, Z);
  applyTransfer(b, "0xAAA", "0xBBB", 30n, Z);
  ok(b["0xaaa"] === "70" && b["0xbbb"] === "30", "transferts appliques, casse normalisee");
  applyTransfer(b, "0xBBB", "0xAAA", 30n, Z);
  ok(b["0xbbb"] === undefined, "solde a zero retire du registre");
  applyTransfer(b, "0xAAA", Z, 100n, Z);
  ok(b["0xaaa"] === undefined, "burn vers l'adresse zero gere");
}

console.log("\n8. Supply variable (Pons peut differer de 1 milliard)");
{
  const SMALL = 1_000_000n * 10n ** 18n;
  const balances = {
    "0xa": ((SMALL * 50n) / 100n).toString(),
    "0xb": ((SMALL * 5n) / 10000n).toString(), // 0,05% : sous le seuil
  };
  const { list } = eligibleHolders(balances, new Set(), SMALL);
  ok(list.length === 1, "le seuil de 0,1% suit la supply reelle");
}

console.log("\n9. Comptabilite par reconciliation");
{
  const E = (n) => ethers.parseEther(String(n));
  const RES = E("0.003");

  // premier entrant
  let r = reconcileBalance(E("0.103"), RES, 0n, 0n, 70);
  ok(r.incoming === E("0.1"), "la reserve de gas est retiree du disponible");
  ok(r.pot === E("0.07") && r.dev === E("0.03"), "split 70/30 sur l'entrant");

  // rien de neuf
  r = reconcileBalance(E("0.103"), RES, E("0.07"), E("0.03"), 70);
  ok(r.incoming === 0n, "un solde inchange ne recompte rien");

  // entrant suivant, par-dessus l'existant
  r = reconcileBalance(E("0.153"), RES, E("0.07"), E("0.03"), 70);
  ok(r.incoming === E("0.05"), "seul le nouvel entrant est compte");

  // apres un paiement : le solde a baisse, on ne doit rien ajouter
  r = reconcileBalance(E("0.02"), RES, E("0.07"), E("0.03"), 70);
  ok(r.incoming === 0n, "un solde en baisse ne produit jamais d'entrant");

  // solde sous la reserve
  r = reconcileBalance(E("0.001"), RES, 0n, 0n, 70);
  ok(r.incoming === 0n, "solde sous la reserve de gas : rien de disponible");

  // le gas consomme creuse un ecart qui se resorbe
  r = reconcileBalance(E("0.1029"), RES, E("0.07"), E("0.03"), 70);
  ok(r.incoming === 0n, "le gas consomme ne cree pas d'entrant negatif");
}

console.log(`\n${pass} OK, ${fail} KO\n`);
process.exit(fail ? 1 : 0);
