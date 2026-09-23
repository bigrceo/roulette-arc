# REPORT — finition de la page $ROULETTE

Exécution autonome de `TASKS-ROULETTE.md`, du début à la fin, sans question
posée. Chaque étape est commitée et poussée sur `main` séparément. Aucun deploy
mainnet, aucune clé écrite nulle part, aucune CGU ni OAuth acceptés, `chain.js`,
`lib.js`, `verify.js`, `test.mjs` et la logique de `index.js` non touchés.

`npm test` : **31 OK, 0 KO** à chaque commit, y compris au dernier.

---

## Ce qui contraint cet environnement (à lire avant le reste)

La machine d'exécution filtre les sorties réseau. Trois refus ont une
conséquence directe sur ce rapport :

| Hôte | Verdict | Conséquence |
|---|---|---|
| `cdn.jsdelivr.net` | 403 (politique de sortie) | Three.js n'est pas téléchargeable depuis le navigateur de capture. Les scripts reroutent les imports `three@0.170.0` vers `node_modules/three`, **même version**, installée en devDependency. Le site en production charge bien le CDN épinglé, rien n'a changé dans `index.html`. |
| `cdn.playwright.dev`, `playwright.download.prss.microsoft.com` | 403 | **webkit et firefox ne sont pas installables.** Voir tâche 7. |
| miroirs Mozilla (`ftp`, `download`, `archive.mozilla.org`), `apt` | 403 / pas de paquet | Aucun autre moteur récupérable non plus. |

Chromium, lui, est préinstallé (`/opt/pw-browsers/chromium`) et son WebGL
fonctionne en SwiftShader (rendu logiciel, d'où les 2 à 4 fps mesurés — c'est
la machine, pas la page).

`fonts.googleapis.com` répond, mais par intermittence : quelques captures
portent un `ERR_TOO_MANY_RETRIES` sur la feuille de polices. Les captures
finales retenues ont toutes les bonnes polices ; `npm run og` refuse
explicitement d'écrire `og.png` si les polices ne se sont pas chargées.

---

## Checklist, ligne par ligne

### 1. Captures de référence avant de toucher — ✅

- `scripts/shots.mjs`, lancé par **`npm run shots`**, une seule commande.
- Il démarre lui-même `mocknode.mjs`, un serveur normal et un serveur en mode
  pré-lancement ; rien à lancer avant.
- États capturés en **1280x800** et **375x812** : `idle`, `locked` (attente de
  `pendingDraw` dans `/api/state`), `prelaunch` (serveur sans `TOKEN_ADDRESS`).
  → les **6 PNG** demandés.
- `shots/` est dans `.gitignore`.
- Playwright installé en devDependency ; `npx playwright install chromium` n'a
  pas été nécessaire, le binaire est déjà là.
- ⚠️ Écart assumé : le script tourne avec `THRESHOLD=0.05` au lieu de 0.25, pour
  que l'état `locked` arrive en moins d'une minute au lieu de ~90 s. Surchargeable
  par `SHOTS_THRESHOLD`. Rien d'autre du cycle ne change.

### 2. Performance du hero 3D — ✅

- `IntersectionObserver` sur `#wheel-3d` dans `wheel-core.js` : `frame()` sort
  avant `composer.render()` dès que le hero quitte l'écran. Au retour, un
  `clock.getDelta()` est jeté pour que la roue ne rattrape pas le temps passé
  hors champ.
- Sous 700 px, `bloom.enabled = false` (5 passes de flou en moins) et le pixel
  ratio reste plafonné à 1.25. Rejoué à chaque `resize`, donc une rotation de
  téléphone repasse dans le bon mode.
- `renderer.info.autoReset = false` + `reset()` par image : sans ça les
  compteurs ne décrivaient que la dernière passe du composer (ils affichaient
  `1`). `window.ROULETTE.info` les expose.

**Draw calls mesurés** (`npm run perf`, Chromium/SwiftShader) :

| | desktop 1280x800 | mobile 375x812 |
|---|---|---|
| bloom | actif | coupé |
| draw calls / image | **129** | **116** |
| triangles / image | 31 554 | 31 541 |
| images rendues hors écran | **0** | **0** |
| draw calls figés hors écran | oui | oui |
| reprise au retour dans le hero | oui | oui |

Les 129 incluent la passe d'ombre (chaque maille est rendue deux fois) et les
passes du composer.

### 3. Fallback sans WebGL — ✅

`wheel.js` est devenu un chargeur de 50 lignes ; la roue est passée dans
`wheel-core.js`, qui peut lever librement. Trois chemins d'échec testés,
**zéro `pageerror`** dans les trois :

| Forçage | Résultat |
|---|---|
| `delete window.WebGLRenderingContext` (le cas de la spec) | poster, `console.info`, aucune erreur |
| `getContext('webgl')` qui rend `null` | poster, idem |
| CDN jsdelivr injoignable | poster, idem (les `ERR_FAILED` réseau viennent du navigateur, pas du code) |
| import map retirée (Safari < 16.4) | poster, idem — bonus de ce découpage |

`window.ROULETTE` reste appelable en no-op, donc le script de page n'a rien à
tester. `public/wheel-poster.jpg` : **1600x1000, 84 Ko**, capture du hero
lui-même par `npm run og` — impossible qu'il diverge des couleurs du site.

⚠️ Sur un écran mobile très étroit, le poster (ratio 1.6:1) est recadré en gros
plan par `object-fit:cover`, donc plus zoomé que la roue 3D au même endroit.
Lisible et cohérent, mais ce n'est pas le même cadrage. Voir
`shots/nowebgl-mobile.png`.

### 4. Image de partage — ✅

- `public/og.html` : page dédiée 1200x630, **non liée dans la navigation**,
  qui réutilise les mêmes variables de couleur, les mêmes polices et le même
  module de roue que le hero. Roue en haut, « The wheel pays one holder. » en
  bas, plus une ligne mono discrète `rouletteonchain.world · Robinhood Chain`.
- `public/og.png` régénéré : **1200x630, 315 Ko** (limite 400 Ko).
- Un PNG 24 bits avec le grain du site pesait ~550 Ko ; `sharp` (devDependency)
  le repasse en palette 256 couleurs.
- La capture est **refusée** si les polices Google ne se sont pas chargées,
  plutôt que de publier une og:image en Times.

### 5. Accessibilité et sémantique — ⚠️ (une violation restante, assumée)

- ✅ Le mot qui alterne dans le H1 porte `aria-live="off"` **et**
  `aria-hidden="true"` ; la phrase complète vit dans un
  `<span class="sr-only">one holder.</span>`. La classe `.sr-only` a été
  ajoutée. Sans `aria-hidden`, un lecteur d'écran lisait les trois variantes à
  la suite.
- ✅ Tous les liens externes ont `rel="noopener"`. Les deux qui manquaient
  étaient ceux du tableau des tirages (adresse gagnante, transaction) : ils
  passent aussi en `target="_blank"` comme les autres, et leurs valeurs sont
  maintenant échappées comme le reste de la page.
- ✅ Contraste : `--cream-faint` passe de `#6B6153` (**3.26:1** sur `--ink`,
  hors norme) à **`#918471`**. Vérifié sur tous les fonds où cette couleur est
  lue :

  | fond | ratio |
  |---|---|
  | `--ink` #0B0A09 (footer, en-têtes de tableau, libellés de stats) | **5.41:1** |
  | `--ink-2` #14110F (avertissement contrat) | 5.14:1 |
  | `--ink-3` #1E1915 | 4.77:1 |
  | tapis, bas du dégradé (légendes de jauge) | 5.08:1 |
  | tapis, haut du dégradé (le plus vert, donc le pire cas) | **4.70:1** |

  L'or (`--au`, `--au-hi`) et le bordeaux (`--blood`) n'ont pas bougé.

**Audit** : `npx @axe-core/cli` est inutilisable ici (il télécharge un
chromedriver, hôte bloqué). `scripts/a11y.mjs` (**`npm run a11y`**) injecte le
même moteur, `axe-core`, dans le Chromium local — mêmes règles, mêmes tags
wcag2a/2aa/21a/21aa — sur la page en marche et la page de pré-lancement, en
desktop et en mobile.

**Il reste une violation `serious`, la même sur les deux pages desktop :**

> `color-contrast` — `.marquee span i` : `#B01E28` sur `#0B0A09` = **2.88:1**,
> attendu 3:1 pour du grand texte. C'est le « *Verify it yourself* » en italique
> du bandeau défilant.

Pas corrigée parce que la spec gèle explicitement le bordeaux (« sans changer
l'or ni le bordeaux »). Le bandeau est décoratif et `aria-hidden="true"` : un
lecteur d'écran ne le voit pas, mais il reste visible à l'œil, donc la remontée
est légitime. Il manque très peu : **`--blood` à `#C4303A` donne 3.61:1** et
`#CC3A44` donne 4.01:1. À décider, ce n'est pas à moi de changer une couleur de
marque. En mobile la violation ne remonte pas (le fragment est hors cadre).

Les ~25 entrées « à vérifier à la main » par page sont toutes le même cas :
axe ne sait pas calculer un contraste au-dessus d'un `<canvas>` (le hero) ou
d'un dégradé translucide. Rien d'actionnable automatiquement.

### 6. Petits défauts visuels — ✅ (les quatre)

**`.scroll-hint` sous 640 px de hero** — ✅
Mesure faite sur la hauteur réelle de `#hero`, rejouée au `resize` et à
l'`orientationchange` (une media query `max-height` aurait raté le cas d'un
hero plus grand que la fenêtre).

| hauteur de hero | « SCROLL » |
|---|---|
| 800 | affiché |
| 700 | affiché |
| 639 | masqué |
| 500 | masqué |
| 800 → 500 à chaud | masqué |
| 500 → 900 à chaud | réaffiché |

Captures : `shots/idle-desktop.png` (affiché), et la vérification de hauteur
est reproductible par le script de la section « Comment revérifier ».

**État `paid` : la barre n'affiche plus 100 %** — ✅
Reproduit avec l'injection documentée dans la spec. Le défaut n'apparaît qu'en
**venant de `locked`** : injecté depuis `idle`, l'affichage était déjà correct
(43 %). Venant de `locked`, avec un pot déjà remonté au-dessus du seuil, on
obtenait :

```
locked        barre 644/646 px   gauche « Wheel locked · draw block #1831 »   droite « 0.4795 / 0.2500 ETH »
locked → paid barre 644/646 px   gauche « Paid to 0xd743…e3d7 »               droite « 100% »   ← le défaut
```

Une barre pleine juste après un paiement veut dire « la roue se verrouille »,
c'est-à-dire exactement l'état `locked`. Après correction :

```
locked → paid barre 637/646 px (99 %)  gauche « Paid to 0xd743…e3d7 »  droite « 0.4851 / 0.2500 ETH »
```

⚠️ Choix assumé, noté ici comme le demande le mode autonome : en `paid` la
jauge est plafonnée strictement sous le plein, et la légende de droite montre
la ligne du pot (comme en `idle`) au lieu d'un pourcentage nu. En production le
bot débite `state.pot` du montant payé, donc la jauge y repart naturellement
bas et le plafond ne joue jamais ; il ne sert qu'à empêcher l'état `paid` de
mentir quand le pot est déjà revenu au niveau du seuil.
Capture : `shots/paid-desktop.png`, `shots/paid-mobile.png`, et le tapis seul
dans `shots/paid-table-desktop.png` (regénéré par le script de vérification).

**`.eyebrow` sur une ligne à 375 px** — ✅
Il tenait déjà, mais **au pixel près** : 319 px de texte pour 319 px
disponibles. Une police de repli, un zoom ou une locale plus large le cassait
en deux. Sous 420 px : `9.5px / .15em / white-space:nowrap`.

| largeur | lignes | débordement |
|---|---|---|
| 320 | 1 | non |
| 375 | 1 | non |
| 414 | 1 | non |

Capture : `shots/idle-mobile.png`.

**« Past spins » : nouvelle ligne en fade-up** — ✅
Le tableau est reconstruit à chaque sondage (10 s). Seules les lignes dont le
numéro de tour n'était pas là au sondage précédent portent `.fresh`, animée par
`row-in` (opacité + 14 px + flou, 0.8 s). Le premier rendu n'anime rien — le
bloc entier apparaît déjà via `.rv`. Neutralisé sous `prefers-reduced-motion`.

| scénario | lignes `.fresh` |
|---|---|
| premier rendu (2 tours) | 0 |
| un tour de plus | 1 (le n°3), `animation-name: row-in`, 0.8 s |
| sondage identique rejoué | 0 |
| deux tours d'un coup | 2 (n°5 et n°4) |

Capture : `shots/rounds-fresh-desktop.png` (regénérée par le script de
vérification).

### 7. Safari et Firefox — ❌ pour les captures, ✅ pour les correctifs

**Pas de capture webkit ni firefox : les moteurs ne sont pas installables.**
`npx playwright install firefox webkit` échoue en 403 sur `cdn.playwright.dev`
**et** sur `playwright.download.prss.microsoft.com` ; les miroirs Mozilla sont
bloqués aussi et `apt` n'a pas de paquet. C'est la politique de sortie de la
machine, pas une erreur de configuration. À refaire depuis une machine avec
accès réseau : `npx playwright install firefox webkit && npm run shots`.

Les quatre points listés dans la spec ont donc été audités statiquement, et
deux étaient de vrais trous :

| Point | Verdict |
|---|---|
| `backdrop-filter` | ⚠️ **corrigé** : le préfixe `-webkit-` n'était présent que sur `.table`. `.btn` (les deux boutons du hero) en était dépourvu — flou perdu sous Safari 15 à 17. Préfixe ajouté. |
| `100svh` | ⚠️ **corrigé** : Safari < 15.4 et Firefox < 101 ignorent l'unité, et sans repli le hero s'effondrait à zéro. `min-height:100vh` ajouté juste avant. |
| import map | ✅ vérifié en retirant la balise : le module tombe dans le `catch` du chargeur et affiche le poster, sans erreur. Capture `shots/noimportmap-desktop.png`. |
| `-webkit-text-stroke` du marquee | ✅ alias supporté par Firefox, rien à faire. |

### 8. README — ✅

Section **« The site »** ajoutée : ce que fait le hero 3D et comment il suit
l'état du round, le découpage chargeur / cœur et tout ce qui déclenche le
poster, la règle du `?v=` (un seul numéro couvre `wheel.js` et
`wheel-core.js`, plus la copie dans `og.html`), les quatre commandes de capture
et de mesure, et la note sur le CDN jsdelivr épinglé sur `three@0.170.0` — avec
la raison de l'épinglage (les addons du composer suivent les internes du cœur).
`npm test` toujours à **31 OK**.

### 9. REPORT.md — ✅

Ce fichier.

---

## Captures finales

Toutes dans `shots/` (dossier gitignoré), régénérables par `npm run shots` :

| fichier | ce qu'elle montre |
|---|---|
| `idle-desktop.png` / `idle-mobile.png` | la roue tourne, le pot se remplit |
| `locked-desktop.png` / `locked-mobile.png` | bloc de tirage annoncé, jauge pleine |
| `paid-desktop.png` / `paid-mobile.png` | gagnant payé (état injecté) |
| `prelaunch-desktop.png` / `prelaunch-mobile.png` | serveur sans `TOKEN_ADDRESS` |
| `nowebgl-desktop.png` / `nowebgl-mobile.png` | WebGL forcé absent : poster statique |
| `noimportmap-desktop.png` | import map retirée (Safari < 16.4) : poster statique |

Deux captures ciblées, produites par le script de vérification ci-dessous et
non par `npm run shots` : `paid-table-desktop.png` (le tapis seul, en état
payé) et `rounds-fresh-desktop.png` (le tableau des tirages).

**Aucune capture webkit ni firefox** — raison au point 7.

## DEMO vs réel

| | |
|---|---|
| **Aucune clé dans le dépôt** | `scripts/harness.mjs` tire une paire jetable avec `ethers.Wallet.createRandom()` à chaque exécution et la donne au faux nœud comme au bot (le bot refuse de claim si le destinataire des fees n'est pas son propre wallet, les deux doivent donc partager une adresse). Rien n'est écrit sur disque. La clé de test littérale de `TASKS-ROULETTE.md` n'a été recopiée nulle part. |
| **Réel, poussé sur `main`** | tout `public/` (`index.html`, `wheel.js`, `wheel-core.js`, `og.html`, `og.png`, `wheel-poster.jpg`), le README, `scripts/`, `package.json`. |
| **DEMO / local seulement** | les données affichées dans toutes les captures viennent de `mocknode.mjs` : 30 holders tirés au hasard, des fees qui tombent toutes les secondes, une clé de test publique à zéro valeur. Aucun chiffre de ces captures n'est un chiffre réel. |
| **DEMO** | l'état `paid` des captures est **injecté** côté `fetch` (la méthode documentée dans la spec), pas un vrai tirage : le tour n°9 et son gagnant `0xd743…` sont fabriqués. |
| **Non fait, impossible ici** | les captures Safari et Firefox. |
| **Inchangé** | `chain.js`, `lib.js`, `verify.js`, `test.mjs`, la logique de `index.js` (claim, tirage, comptabilité, posts X). `index.js` n'a pas été touché du tout, pas même la table MIME : `.jpg` y était déjà. |
| **Dépendance runtime** | toujours `ethers` seule. `playwright`, `three`, `@axe-core/playwright`, `axe-core` et `sharp` sont en `devDependencies` et ne partent pas sur Vercel. `three` en devDependency sert uniquement à servir la même version que le CDN aux scripts de capture, le CDN étant bloqué ici. |

---

## Ce que je dois faire au réveil

1. **Regarder `rouletteonchain.world`** après le redéploiement automatique
   (huit pushes sur `main` depuis hier soir). Vérifier surtout que la roue 3D
   se charge bien depuis jsdelivr : c'est le seul chemin qui n'a **pas** pu
   être testé ici, puisque le CDN est bloqué sur la machine de build. Si la
   roue ne vient pas, le poster s'affiche à la place et la console dit
   pourquoi — la page ne casse pas, mais il faut le savoir.
2. **Passer `og.png` dans un validateur de partage** (cards-dev.twitter.com,
   le debugger OpenGraph de Facebook, ou simplement coller le lien dans un DM).
   L'image fait 1200x630 / 315 Ko et l'URL `og:image` est absolue, mais les
   caches des réseaux gardent l'ancienne version un moment : forcer le
   rafraîchissement.
3. **Trancher sur le bordeaux du marquee** (point 5). C'est la seule violation
   `serious` restante. `--blood` à `#C4303A` suffit (3.61:1) ; je ne l'ai pas
   fait parce que la spec gèle cette couleur.
4. **Relancer les captures Safari et Firefox** depuis une machine sans
   filtrage : `npx playwright install firefox webkit && npm run shots`, puis
   regarder le hero et le tapis sur les deux moteurs. Les deux correctifs du
   point 7 (`100svh`, `-webkit-backdrop-filter`) sont des paris raisonnables,
   pas des observations.
5. **Se souvenir du `?v=`** : il est à **7**. Toute modification de `wheel.js`
   ou `wheel-core.js` demande de l'incrémenter dans `index.html`, et de mettre
   `og.html` en phase.
6. Rien à faire côté clés, Railway ou Vercel : aucun secret n'a été touché,
   aucun deploy manuel lancé.

---

## Comment revérifier, en une commande chacune

```bash
npm install
npm test     # 31 OK, 0 KO
npm run shots   # 11 PNG dans shots/
npm run perf    # draw calls + preuve que la boucle s'arrête hors écran
npm run a11y    # axe-core ; sort en erreur tant qu'il reste du serious
npm run og      # régénère wheel-poster.jpg et og.png
```

Les vérifications plus fines du point 6 (hauteur du hero, largeur de
l'eyebrow, lignes `.fresh`, transition `locked → paid`) ont été faites par des
scripts jetables qui n'ont pas été commités, pour ne pas alourdir le dépôt.
Elles sont reproductibles à la main dans la console du navigateur :
l'injection `paid` est celle de `TASKS-ROULETTE.md`, et le reste se lit avec
`document.getElementById('scroll-hint').hidden`,
`document.querySelector('.eyebrow').getBoundingClientRect()` et
`document.querySelectorAll('tbody tr.fresh')`.
