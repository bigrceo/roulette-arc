// ===========================================================================
//  Logique du tirage. Aucune dependance reseau, aucune constante de chaine.
//  index.js et verify.js importent CE fichier — le script de verification
//  ne peut donc pas diverger du bot, meme si les regles changent plus tard.
//  C'est cette propriete qui rend l'argument de confiance solide :
//  ne la casse jamais.
// ===========================================================================

/** Part minimale de la supply pour etre eligible : 0,1%. */
export const MIN_HOLD_BPS = 10n; // sur 10 000

/** Racine carree entiere (Newton). Deterministe, aucun flottant. */
export function isqrt(n) {
  if (n < 2n) return n;
  let x = n,
    y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/**
 * Holders eligibles et leur poids.
 *
 * Poids = racine carree du solde. Detenir plus augmente les chances, mais
 * doubler sa position les multiplie par 1,41 et non par 2. Sans ca, un
 * wallet a 60% de la supply gagne 60% des tirages et les petits porteurs
 * partent.
 *
 * @param balances  { adresse: solde en string }
 * @param excluded  Set d'adresses en minuscules a ecarter
 * @param totalSupply  supply totale, en plus petite unite
 */
export function eligibleHolders(balances, excluded, totalSupply) {
  const minHold = (totalSupply * MIN_HOLD_BPS) / 10_000n;

  const list = Object.entries(balances)
    .filter(
      ([addr, bal]) =>
        !excluded.has(addr.toLowerCase()) && BigInt(bal) >= minHold
    )
    .map(([addr, bal]) => ({ addr: addr.toLowerCase(), balance: BigInt(bal) }))
    // ordre lexicographique : deux machines qui rejouent les memes events
    // obtiennent la meme liste, donc le meme gagnant
    .sort((a, b) => (a.addr < b.addr ? -1 : 1));

  let total = 0n;
  for (const h of list) {
    h.weight = isqrt(h.balance);
    total += h.weight;
  }
  return { list, total };
}

/**
 * Gagnant = hash du bloc cible projete sur la liste ponderee.
 * Le bloc est annonce avant d'etre mine : son hash est imprevisible au
 * moment de l'annonce, y compris par l'operateur.
 */
export function pickWinner(list, total, blockHash) {
  if (!list.length || total === 0n) return null;
  let point = BigInt(blockHash) % total;
  for (const h of list) {
    if (point < h.weight) return h;
    point -= h.weight;
  }
  return list[list.length - 1];
}

/** Decoupe un montant reclame entre le pot et le createur. */
export function splitAmount(amount, potSharePct) {
  const pot = (amount * BigInt(potSharePct)) / 100n;
  return { pot, dev: amount - pot };
}

/**
 * Comptabilite : que repartir, vu le solde reel du wallet.
 *
 * On ne mesure pas un delta autour d'une transaction — c'est fragile, parce
 * que le gas sort du meme solde quand les fees sont en actif natif, qu'un RPC
 * peut servir une valeur d'un bloc anterieur, et qu'un claim a moitie echoue
 * fausse le compte. On regarde ce qui est reellement disponible.
 *
 * Tout ce qui depasse ce qui est deja comptabilise est un entrant, reparti
 * selon le split. Un solde en baisse (gas consomme, paiement effectue) ne
 * produit rien : la fonction ne retire jamais.
 *
 * @returns { incoming, pot, dev } — montants a AJOUTER, 0n si rien de neuf
 */
export function reconcileBalance(balance, gasReserve, knownPot, knownDev, potSharePct) {
  const available = balance > gasReserve ? balance - gasReserve : 0n;
  const known = knownPot + knownDev;
  if (available <= known) return { incoming: 0n, pot: 0n, dev: 0n };

  const incoming = available - known;
  const { pot, dev } = splitAmount(incoming, potSharePct);
  return { incoming, pot, dev };
}

/** Applique un event Transfer au registre des soldes (mutation en place). */
export function applyTransfer(balances, from, to, value, zeroAddress) {
  const a = from.toLowerCase(),
    b = to.toLowerCase();
  if (a !== zeroAddress) {
    const cur = BigInt(balances[a] || "0") - value;
    if (cur <= 0n) delete balances[a];
    else balances[a] = cur.toString();
  }
  if (b !== zeroAddress) {
    balances[b] = (BigInt(balances[b] || "0") + value).toString();
  }
}
