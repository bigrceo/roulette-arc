# $JACKPOT — bot + site

Chaque trade alimente un pot. Au seuil, un holder tiré au sort prend tout.
Tirage basé sur le hash d'un bloc annoncé à l'avance, donc vérifiable par
n'importe qui.

---

## Avant de lancer le token

**Crée un wallet neuf et dédié.** Jamais ton wallet principal.

C'est ce wallet qui doit lancer le token sur Argus, parce que `claim()` sur le
`RevenueSplitter` ne peut être appelé que par le créateur. Le bot a besoin de
sa clé privée pour claim et pour payer les gagnants.

Config au lancement sur Argus :

- Buy tax **5%**, sell tax **5%**
- Creator funds **100%** — les 3 autres à 0%

Le 100% n'est pas de l'extraction, c'est la seule façon de programmer une
mécanique custom : Argus ne propose que 4 destinations fixes et les dividendes
natifs ne payent qu'en USDC au prorata. Le bot reprend la main sur ces fonds et
en envoie `POT_SHARE`% dans le pot.

Garde une dizaine d'USDC sur le wallet du bot pour le gas.

---

## Vérifier que la logique marche (sans réseau)

```bash
npm install
npm test
```

20 tests sur le tirage : racine carrée, éligibilité, déterminisme, distribution
des chances, arrondis de la découpe 70/30, comptabilité des soldes. Ça ne teste
pas le réseau Arc, mais ça garantit que la mécanique elle-même est correcte.

---

## Démarrage

```bash
npm install

export PRIVATE_KEY="0x..."            # wallet créateur dédié
export TOKEN_ADDRESS="0x..."          # ton token une fois lancé
export DEPLOY_BLOCK="20401234"        # bloc de la tx de création
export POT_SHARE=70
export THRESHOLD_USDC=50

npm start
```

Le site tourne sur `http://localhost:3000`, l'API sur `/api/state`.

Au démarrage le bot affiche le chainId (doit être **5042**), le splitter, et
prévient si le wallet du bot n'est pas le créateur — auquel cas `claim()`
échouera.

**Fais tourner en lecture seule d'abord** (sans `PRIVATE_KEY`) pour vérifier
que l'indexation des holders marche avant de lui confier des fonds.

---

## Déploiement

Railway ou Render. Push sur GitHub, connecte le repo, ajoute les variables
d'environnement, deploy.

`state.json` contient l'historique des rounds et l'index des holders. Sur
Railway, monte un volume persistant sur le dossier de l'app, sinon un redeploy
réindexe tout depuis `DEPLOY_BLOCK` (ça marche, mais c'est lent et ça perd
l'historique des rounds).

---

## Le tirage, en détail

1. Le pot atteint le seuil → le bot annonce un round et fixe un **bloc cible**
   à `DRAW_DELAY_BLOCKS` blocs dans le futur. Le site l'affiche immédiatement.
2. Ce bloc n'existe pas encore. Son hash est imprévisible, y compris pour toi.
3. Quand le bloc tombe, les soldes sont figés **à ce bloc exact**, reconstruits
   depuis les events `Transfer`.
4. Poids de chaque holder = `√(solde)`. Gagnant = `hash % poids_total` projeté
   sur la liste triée par adresse.
5. Paiement en USDC, txid enregistré et affiché.

`verify.js` recalcule tout depuis la chain et compare :

```bash
TOKEN_ADDRESS=0x… DEPLOY_BLOCK=… EXCLUDED=0xlocker,0xhook,0xsplitter,0xbot \
  node verify.js 3
```

Bot et script de vérification importent **le même `lib.js`**, donc ils ne
peuvent pas diverger. C'est ce script que tu publies.

---

## Limites connues — lis-les avant de promettre quoi que ce soit

**Split en plusieurs wallets.** Avec la racine carrée, `√a + √b > √(a+b)`. Un
gros holder peut découper sa position en N wallets et augmenter ses chances.
Le minimum de 0,1% de supply par wallet limite l'ampleur et le gas décourage,
mais la faille existe. Aucune pondération ne résout ça proprement sans identité.

**Un holder peut vendre juste après le tirage.** Rien ne l'en empêche.

**Le wallet du bot détient des USDC et sa clé est sur un serveur.** Claim juste
avant le tirage limite l'exposition, mais le risque reste réel. Ne laisse
jamais dormir de grosses sommes dessus.

**L'ABI vient d'un repo reconstitué.** Les adresses et signatures viennent de
`github.com/arguspad/argus-world`, mais ce repo indique lui-même être une
version simplifiée du contrat #7 réel. Vérifie `claim()` et
`creditedToCreator()` contre le bundle officiel `arguspad.io/argus-v4.json`
avant de compter dessus.

**Cadre légal.** Une mécanique de tirage au sort avec mise peut relever du
régime des jeux d'argent. Je ne suis pas juriste. Regarde comment les projets
comparables formulent les choses avant de publier.

---

## Ce qu'il te reste à faire

- Vérifier le RPC et l'ABI en conditions réelles (non testable depuis mon
  environnement, qui n'a pas accès à Arc)
- Publier le repo pour que `verify.js` soit auditable — c'est tout l'argument
  de confiance
- Brancher un nom de domaine
- Poster chaque round
