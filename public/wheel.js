// ===========================================================================
//  $ROULETTE — chargeur du hero.
//
//  Ce fichier ne fait qu'une chose : decider si la roue 3D peut tourner.
//    - WebGL absent, ou contexte refuse                -> poster statique
//    - three.js (CDN) injoignable, ou WebGLRenderer     -> poster statique
//      qui leve pendant l'evaluation de wheel-core.js
//  Le poster passe par le meme cadre que la roue, donc rien ne bouge dans la
//  mise en page, et rien ne part en erreur rouge dans la console.
//
//  API (fournie par wheel-core.js, ou en no-op ici) :
//    window.ROULETTE.setState('idle' | 'locked' | 'paid')
// ===========================================================================

const host = document.getElementById("wheel-3d");

const POSTER = "/wheel-poster.jpg";

function showPoster(reason) {
  if (!host) return;
  host.replaceChildren();
  const img = document.createElement("img");
  img.src = POSTER;
  img.alt = "";           // decoratif : le conteneur est deja aria-hidden
  img.decoding = "async";
  host.appendChild(img);
  host.classList.add("fallback", "ready");
  // un message d'information, pas une erreur : la page reste propre
  console.info("[roulette] hero 3D desactive (" + reason + "), poster statique");
}

if (!window.ROULETTE) {
  window.ROULETTE = { setState() {}, get state() { return "idle"; }, get info() { return { fallback: true }; } };
}

function webglAvailable() {
  if (typeof window.WebGLRenderingContext === "undefined") return false;
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl") || c.getContext("experimental-webgl"));
  } catch {
    return false;
  }
}

if (!host) {
  console.info("[roulette] pas de #wheel-3d sur cette page");
} else if (!webglAvailable()) {
  showPoster("WebGL indisponible");
} else {
  // la version (?v=N) de index.html est reportee telle quelle sur le coeur :
  // un seul numero a bumper pour les deux fichiers
  const v = new URL(import.meta.url).search;
  import("./wheel-core.js" + v).catch((err) => showPoster(String(err && err.message || err)));
}
