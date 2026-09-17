// Logique pure du tirage — sans réseau, donc testable et vérifiable.
// verify.js et index.js utilisent exactement ce fichier : aucun risque que
// le script de vérification diverge du bot.

export const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;
export const MIN_HOLD_PCT = 0.001;   // 0,1% de la supply pour être éligible

/** Racine carrée entière (Newton). Déterministe, pas de flottant. */
export function isqrt(n) {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

/**
 * Liste des holders éligibles et leur poids.
 * Poids = racine carrée du solde : détenir plus augmente les chances,
 * mais doubler sa position ne les double pas.
 */
export function eligibleHolders(balances, excluded) {
  const minHold = (TOTAL_SUPPLY * BigInt(Math.round(MIN_HOLD_PCT * 1e6))) / 1_000_000n;

  const list = Object.entries(balances)
    .filter(([addr, bal]) => !excluded.has(addr.toLowerCase()) && BigInt(bal) >= minHold)
    .map(([addr, bal]) => ({ addr: addr.toLowerCase(), balance: BigInt(bal) }))
    .sort((a, b) => (a.addr < b.addr ? -1 : 1)); // ordre déterministe

  let total = 0n;
  for (const h of list) { h.weight = isqrt(h.balance); total += h.weight; }
  return { list, total };
}

/** Gagnant = hash du bloc cible projeté sur la liste pondérée. */
export function pickWinner(list, total, blockHash) {
  if (!list.length || total === 0n) return null;
  let point = BigInt(blockHash) % total;
  for (const h of list) {
    if (point < h.weight) return h;
    point -= h.weight;
  }
  return list[list.length - 1];
}

/** Découpe un montant claimé entre le pot et le créateur. */
export function splitAmount(amount, potSharePct) {
  const pot = (amount * BigInt(potSharePct)) / 100n;
  return { pot, dev: amount - pot };
}

/** Applique un event Transfer au registre des soldes (mutation en place). */
export function applyTransfer(balances, from, to, value, zeroAddress) {
  const a = from.toLowerCase(), b = to.toLowerCase();
  if (a !== zeroAddress) {
    const cur = BigInt(balances[a] || "0") - value;
    if (cur <= 0n) delete balances[a];
    else balances[a] = cur.toString();
  }
  if (b !== zeroAddress) {
    balances[b] = (BigInt(balances[b] || "0") + value).toString();
  }
}
