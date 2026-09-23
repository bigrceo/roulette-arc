# TASKS-ROULETTE.md — finir la page du site $ROULETTE

## MODE AUTONOME

Je dors, personne ne répond. Ne pose aucune question. Si bloqué : choisis l'option la plus simple, note-la dans REPORT.md, continue. Commit + push après chaque étape. Si un site externe ou une install réseau échoue, documente et avance sur le reste. Aucun deploy mainnet, aucune clé. À la fin : REPORT.md en FR (fait / pas fait / DEMO vs réel / ce que je dois faire au réveil).

AVANT DE FINIR : relis la spec ligne par ligne et coche chaque exigence dans REPORT.md (✅ fait / ⚠️ partiel / ❌ pas fait), sans enjoliver. Tests + build doivent passer. Si tu peux lancer le site et prendre des captures, fais-le et corrige ce qui est cassé visuellement.

## Contexte, à lire d'abord

- `README.md` puis `public/index.html` et `public/wheel.js`. Le site est servi par `index.js` (`npm start`, port 3000, mode pré-lancement sans `TOKEN_ADDRESS`). Le même dossier `public/` est aussi déployé en statique sur Vercel (`vercel.json`), avec `/api/*` réécrit vers le bot Railway. Un push sur `main` redéploie les deux tout seul : c'est le seul "deploy" autorisé ici.
- Règle absolue : `lib.js`, `verify.js`, `chain.js`, la logique de `index.js` (claim, tirage, comptabilité, posts X) ne bougent pas. Tu ne touches qu'à `public/`, au README, et au serveur statique de `index.js` si un type MIME manque.
- Ne jamais afficher un pourcentage de la taxe de trade. Seulement "70% de ce qui arrive", pot / seuil.
- Cycle complet en local pour voir tous les états :
  ```
  MOCK_CREATOR=0xe239cdc5fbe977a8a141B72194D3CF8c41bC5BC6 node mocknode.mjs &
  PRIVATE_KEY=0xabababababababababababababababababababababababababababababababab \
  TOKEN_ADDRESS=0x1111111111111111111111111111111111111111 DEPLOY_BLOCK=1000 \
  RPC_URL=http://127.0.0.1:8545 PONS_ESCROW=0x2222222222222222222222222222222222222222 \
  THRESHOLD=0.25 GAS_RESERVE=0.005 DRAW_DELAY_BLOCKS=480 TICK_SECONDS=2 PORT=3000 STATE_DIR=/tmp/rs npm start
  ```
  (clé de test connue de tous, zéro valeur, n'existe que pour le mock)
- `npm test` = 31 assertions, doit rester vert.
- Le script `public/wheel.js` est chargé avec `?v=N` dans `index.html` : bumpe N à chaque modification de `wheel.js`, sinon le navigateur garde l'ancien une heure.

## Tâches, dans l'ordre. Critère de "fini" pour chacune.

1. **Captures de référence avant de toucher.** Installe Playwright (`npx playwright install chromium` ; si le réseau refuse, note-le et passe aux tests sans capture). Script `scripts/shots.mjs` qui capture `/` en 1280x800 et 375x812 avec le mock, états idle, locked (attendre `pendingDraw` dans `/api/state`), et pré-lancement (serveur sans `TOKEN_ADDRESS`). Fini quand : 6 PNG dans `shots/` (dossier gitignoré) et le script tourne en une commande `npm run shots`.

2. **Performance du hero 3D.** Le rendu ne doit tourner que quand le hero est visible : IntersectionObserver sur `#wheel-3d`, boucle en pause sinon. Sur mobile (< 700 px), bloom désactivé ou résolution du composer divisée par 2. Fini quand : dans `wheel.js`, la boucle `frame()` ne rend rien quand le hero est hors écran, et `renderer.info.render.calls` reste stable ; documente le nombre de draw calls dans REPORT.md.

3. **Fallback sans WebGL.** Si `WebGLRenderingContext` est absent ou que `new THREE.WebGLRenderer` lève, afficher `public/wheel-poster.jpg` (à générer : capture 1600x1000 du hero avec Playwright, ou à défaut le `og.png` existant) dans `#wheel-3d`. Fini quand : en forçant l'échec (par ex. `window.WebGLRenderingContext = undefined` avant le module), la page reste propre avec l'image, sans erreur console rouge.

4. **Image de partage.** Régénère `public/og.png` (1200x630) depuis le nouveau hero : roue 3D en haut, "The wheel pays one holder." en bas, mêmes couleurs. Playwright sur une page dédiée `public/og.html` (non liée dans la nav) ou composition avec `sharp` si disponible. Fini quand : `og.png` fait 1200x630, moins de 400 Ko, et `og.html` est présent pour la régénérer.

5. **Accessibilité et sémantique.** Le mot qui alterne dans le H1 doit avoir `aria-live="off"` et une version texte complète dans un `<span class="sr-only">` (ajoute la classe). Tous les liens externes `rel="noopener"`. Contraste du texte `--cream-faint` sur `--ink` ≥ 4.5:1 pour le texte lu (légendes, footer) : ajuste la variable si besoin, sans changer l'or ni le bordeaux. Fini quand : `npx @axe-core/cli http://localhost:3000` (ou `pa11y`) ne remonte aucune erreur "serious" ou "critical" ; sinon, liste les restantes dans REPORT.md.

6. **Petits défauts visuels à corriger** (vérifie chacun sur les captures) :
   - Le `.scroll-hint` "SCROLL" ne doit pas apparaître si le hero fait moins de 640 px de haut.
   - En état `paid`, la barre affiche le pourcentage du pot courant, pas 100 %. Vérifie avec l'injection d'état documentée ci-dessous.
   - Sur mobile, le `.eyebrow` tient sur une ligne à 375 px.
   - Le tableau "Past spins" : nouvelle ligne = fade-up, pas d'apparition sèche.
   Fini quand : chaque point est coché dans REPORT.md avec la capture correspondante.

   Injection d'état `paid` sans attendre le mock (dans la console du navigateur ou via Playwright `page.evaluate`) :
   ```
   const real = window.fetch; const s = await (await real('/api/state')).json();
   const fake = {...s, pendingDraw:null, rounds:[{round:9, at:new Date().toISOString(), targetBlock:4242, winner:'0xd74393ebf658274f4114f8db6c430dbc0206e3d7', txHash:'0x'+'ab'.repeat(32), amount:0.05, eligibleCount:30}, ...s.rounds]};
   window.fetch = (u) => u === '/api/state' ? Promise.resolve({json: () => Promise.resolve(fake)}) : real(u); await load();
   ```

7. **Safari et Firefox.** Playwright `webkit` et `firefox` si installables : capture du hero et du tapis. Points connus à surveiller : `backdrop-filter` (préfixe déjà présent), `100svh`, importmap (supporté partout depuis 2023), `-webkit-text-stroke` du marquee. Fini quand : captures dans `shots/` ou raison documentée.

8. **README.** Section "The site" : ce que fait le hero 3D, comment lancer les captures, comment bumper `?v=`, la note sur le CDN jsdelivr épinglé (three@0.170.0). Fini quand : la section existe et `npm test` est toujours à 31 OK.

9. **REPORT.md** en FR, à la racine, avec la checklist de chaque tâche ci-dessus (✅ / ⚠️ / ❌), les captures finales listées, et "ce que je dois faire au réveil" (au minimum : regarder rouletteonchain.world après le redéploiement automatique, vérifier og.png dans un validateur de partage).

## Interdit

- Pas de nouvelle dépendance dans `package.json` côté runtime (ethers reste la seule). Playwright, axe, sharp uniquement en devDependencies ou via `npx`.
- Pas de modification de `chain.js`, `lib.js`, `verify.js`, `test.mjs` (sauf ajout de tests), ni de la logique de `index.js`.
- Pas de clé, pas de variable Railway ou Vercel, pas de deploy manuel : le push suffit.
- Pas de nouveau nom, pas de nouveau domaine, pas de texte qui promet un pourcentage de la taxe.
