// ===========================================================================
//  Posts automatiques sur X. Aucune dependance : OAuth 1.0a signe a la main
//  (HMAC-SHA1), POST https://api.x.com/2/tweets.
//
//  Quatre variables d'environnement, toutes vides = desactive :
//    X_API_KEY, X_API_SECRET        (l'app, portail developpeur X)
//    X_ACCESS_TOKEN, X_ACCESS_SECRET (le compte @getroulette, droits Read+Write)
//  X_DRY_RUN=true : affiche le post dans les logs sans l'envoyer.
//
//  Un echec de post ne doit jamais bloquer un tirage : tout est try/catch
//  cote appelant, et on ne reessaie pas (le round continue, X attendra).
// ===========================================================================

import crypto from "crypto";

const KEYS = {
  key: process.env.X_API_KEY || "",
  secret: process.env.X_API_SECRET || "",
  token: process.env.X_ACCESS_TOKEN || "",
  tokenSecret: process.env.X_ACCESS_SECRET || "",
};
const DRY = /^(1|true|yes)$/i.test(process.env.X_DRY_RUN || "");

export const xEnabled = () => DRY || Boolean(KEYS.key && KEYS.secret && KEYS.token && KEYS.tokenSecret);

// ---------------------------------------------------------------------------
// Templates. {round} {pot} {symbol} {block} {winner} {tx} {site} {explorer}
// Surchargeables par X_TEMPLATE_ANNOUNCE / X_TEMPLATE_RESULT / X_TEMPLATE_HALF.
// ---------------------------------------------------------------------------
export const TEMPLATES = {
  announce:
    process.env.X_TEMPLATE_ANNOUNCE ||
    "Spin #{round} is locked.\n\n{pot} {symbol} on the table.\nThe winner comes from block {block} — not mined yet. Nobody can predict its hash. Not you, not us.\n\nWatch it land: {site}",
  result:
    process.env.X_TEMPLATE_RESULT ||
    "Spin #{round} paid.\n\n{pot} {symbol} → {winner}\nBlock {block}, hash on-chain, payout on-chain: {tx}\n\nCheck it yourself: {site}",
  half:
    process.env.X_TEMPLATE_HALF ||
    "The pot is halfway there: {pot} {symbol} on the table, spins at {threshold} {symbol}.\n\nOne holder takes all of it. {site}",
};

export function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

// ---------------------------------------------------------------------------
// OAuth 1.0a
// ---------------------------------------------------------------------------
const enc = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * Signature HMAC-SHA1 d'une requete. `params` = parametres oauth_* + query
 * (le corps JSON d'un POST v2 n'entre pas dans la signature).
 * Exportee pour etre testee contre l'exemple officiel de la doc X.
 */
export function oauthSignature(method, url, params, consumerSecret, tokenSecret) {
  const normalized = Object.keys(params)
    .map((k) => [enc(k), enc(params[k])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = `${method.toUpperCase()}&${enc(url)}&${enc(normalized)}`;
  const key = `${enc(consumerSecret)}&${enc(tokenSecret)}`;
  return crypto.createHmac("sha1", key).update(base).digest("base64");
}

export function oauthHeader(method, url, keys = KEYS, extra = {}) {
  const oauth = {
    oauth_consumer_key: keys.key,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: keys.token,
    oauth_version: "1.0",
    ...extra,
  };
  oauth.oauth_signature = oauthSignature(method, url, oauth, keys.secret, keys.tokenSecret);
  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${enc(k)}="${enc(oauth[k])}"`)
      .join(", ")
  );
}

// ---------------------------------------------------------------------------
// Envoi
// ---------------------------------------------------------------------------
const URL = "https://api.x.com/2/tweets";

/** Poste un tweet. Retourne son id, ou null si desactive / echec. */
export async function post(text) {
  if (!xEnabled()) return null;
  if (text.length > 280) text = text.slice(0, 277) + "…";
  if (DRY) {
    console.log(`[X dry-run]\n${text}\n`);
    return "dry-run";
  }
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      Authorization: oauthHeader("POST", URL),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`X ${res.status}: ${body.detail || body.title || JSON.stringify(body).slice(0, 200)}`);
  }
  return body.data?.id || null;
}
