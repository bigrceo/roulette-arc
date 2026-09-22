// ===========================================================================
//  TOUT CE QUI EST SPECIFIQUE A ROBINHOOD CHAIN ET A PONS VIT ICI.
//  Le reste du projet ne connait pas la chaine. Pour adapter le bot,
//  tu ne touches qu'a ce fichier.
//
//  Les adresses ci-dessous ont ete lues sur la chaine (sonde du 2026-09-22,
//  contrats verifies sur Blockscout), pas recopiees d'une doc :
//    PonsV2LaunchFactory  0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
//    PonsV2FeeEscrow      0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e
//  L'escrow est global (une adresse pour tous les tokens) et paie msg.sender :
//    claim()               -> solde natif (ETH) du createur
//    claimToken(pairToken) -> solde ERC20 (ex. USDG) du createur
//  Les deux revert `NoBalance()` quand il n'y a rien : cas normal.
//  Le createur = `creatorFeeRecipient` du launch = le wallet qui a lance.
//  Le bot doit donc etre lance DEPUIS le wallet du bot.
// ===========================================================================

import { ethers } from "ethers";

export const CHAIN = {
  name: "Robinhood Chain",
  id: 4663,
  // L2 Arbitrum : gas et actif natif en ETH, 18 decimales
  nativeSymbol: "ETH",
  nativeDecimals: 18,
  rpc: process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
  explorer: "https://robinhoodchain.blockscout.com",
  // Mesure par la sonde : 0,101 s par bloc (~594 blocs/min).
  // DRAW_DELAY_BLOCKS=1800 ≈ 3 min de fenetre entre l'annonce et le tirage.
  isArbitrumL2: true,
  blockTimeSeconds: 0.101,
};

// ---------------------------------------------------------------------------
// PONS V2 — adresses reelles
// ---------------------------------------------------------------------------
export const PONS_V2 = {
  factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
  escrow: "0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e",
  // Infra qui detient des tokens sans etre un holder. Lue via la factory.
  poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951", // Uniswap v4, ~90% apres graduation
  locker: "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952", // ~8% apres graduation
  buybackVault: "0x42df2a798f82289E177311362e8f5ccC45c1219c",
  positionManager: "0x58daec3116aae6D93017bAAea7749052E8a04fA7",
  memeHook: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044",
  launchForwarder: "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948",
  // Pairing assets approuves avec une vraie liquidite (nb de launches sur
  // 300k blocs) : ETH natif 3609, USDG 320, NVDA 209, SPCX 100.
  pairTokens: {
    USDG: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6, name: "Global Dollar" },
  },
};

export const PONS = {
  factory: process.env.PONS_FACTORY || PONS_V2.factory,
  escrow: process.env.PONS_ESCROW || PONS_V2.escrow,

  // Actif dans lequel les fees sont payees = pairing asset du launch.
  // null = ETH natif. Une adresse = ERC20 (ex. USDG, 6 decimales).
  // Si non fourni, decouvert au demarrage via factory.getLaunchedToken().
  feeAsset: process.env.FEE_ASSET || null,
  feeDecimals: Number(process.env.FEE_DECIMALS || 18),

  // Contrats a exclure du tirage. La bonding curve du token est ajoutee
  // automatiquement au demarrage (discoverLaunch). EXCLUDED complete.
  excluded: [
    PONS_V2.factory,
    PONS_V2.escrow,
    PONS_V2.poolManager,
    PONS_V2.locker,
    PONS_V2.buybackVault,
    PONS_V2.positionManager,
    PONS_V2.memeHook,
    PONS_V2.launchForwarder,
    ...(process.env.EXCLUDED || "").split(","),
  ]
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
};

// ---------------------------------------------------------------------------
// FACTORY — decouverte du launch
// ---------------------------------------------------------------------------
export const FACTORY_ABI = [
  "function getLaunchedToken(address token) view returns (tuple(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
  "function getLaunchFeePolicy(address token) view returns (tuple(address protocolFeeRecipient, uint16 protocolFeeShareBps, uint16 buybackBurnBps, uint16 hookFeeBps, uint16 maxInternalPriceImpactBps))",
  "function feeEscrow() view returns (address)",
  "function approvedPairTokens(address) view returns (bool)",
];

export const ESCROW_ABI = [
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient, address token) view returns (uint256)",
  "function claim() returns (uint256)",
  "function claimToken(address token) returns (uint256)",
];

/**
 * Lit la config du launch sur la factory. Retourne null si le token n'est
 * pas un launch Pons V2. Ne modifie rien : l'appelant decide.
 */
export async function discoverLaunch(provider, tokenAddress) {
  const f = new ethers.Contract(PONS.factory, FACTORY_ABI, provider);
  const lt = await f.getLaunchedToken(tokenAddress);
  if (!lt.exists) return null;
  let policy = null;
  try {
    const pol = await f.getLaunchFeePolicy(tokenAddress);
    policy = { protocolFeeShareBps: Number(pol.protocolFeeShareBps), hookFeeBps: Number(pol.hookFeeBps) };
  } catch {}
  const pairToken = lt.pairToken === ethers.ZeroAddress ? null : lt.pairToken;
  return {
    curve: lt.curve,
    deployer: lt.deployer,
    creatorFeeRecipient: lt.creatorFeeRecipient,
    pairToken,
    creatorTaxBps: Number(lt.creatorTaxBps),
    phase: Number(lt.phase), // 0 = ?, 1 = sur la curve, 2 = gradue (observe)
    policy,
  };
}

/** Montant en attente dans l'escrow pour `recipient`, dans l'actif de paiement. */
export async function pendingInEscrow(provider, recipient) {
  const e = new ethers.Contract(PONS.escrow, ESCROW_ABI, provider);
  return feeIsNative() ? e.balanceOf(recipient) : e.balanceOfToken(recipient, PONS.feeAsset);
}

// ---------------------------------------------------------------------------
// CANDIDATS DE SIGNATURE
// ---------------------------------------------------------------------------
// Les deux premiers sont ceux du PonsV2FeeEscrow verifie. Le reste est garde
// en secours si Pons change d'escrow : probe.js et le bot essaient dans
// l'ordre et retiennent ce qui repond.
// args recoit (walletDuBot, tokenLance, feeAsset).
// ---------------------------------------------------------------------------

export const CLAIM_CANDIDATES = [
  { sig: "function claim() external returns (uint256)", args: () => [], native: true },
  { sig: "function claimToken(address token) external returns (uint256)", args: (to, tok, fee) => [fee], erc20: true },
  { sig: "function claim(address to) external", args: (to) => [to] },
  { sig: "function claimFees(address to) external", args: (to) => [to] },
  { sig: "function claimFees() external", args: () => [] },
  { sig: "function withdraw() external", args: () => [] },
  { sig: "function withdraw(address to) external", args: (to) => [to] },
  { sig: "function withdrawFees() external", args: () => [] },
  { sig: "function collectFees() external", args: () => [] },
  { sig: "function collect() external", args: () => [] },
  { sig: "function harvest() external", args: () => [] },
  { sig: "function claim(address token, address to) external", args: (to, tok) => [tok, to] },
  { sig: "function claimFor(address token) external", args: (to, tok) => [tok] },
  { sig: "function withdraw(address token, address to) external", args: (to, tok) => [tok, to] },
];

/** Candidats applicables a l'actif de paiement courant. */
export const claimCandidates = () =>
  CLAIM_CANDIDATES.filter((c) => (feeIsNative() ? !c.erc20 : !c.native));

// Getters possibles du montant en attente (affichage du pot en attente).
export const PENDING_CANDIDATES = [
  "function balanceOf(address) view returns (uint256)",
  "function pendingFees(address) view returns (uint256)",
  "function claimable(address) view returns (uint256)",
  "function claimableFees(address) view returns (uint256)",
  "function earned(address) view returns (uint256)",
  "function accruedFees(address) view returns (uint256)",
  "function feesOf(address) view returns (uint256)",
];

// Getters possibles du createur / proprietaire des fees.
export const CREATOR_CANDIDATES = [
  "function creator() view returns (address)",
  "function owner() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function deployer() view returns (address)",
];

// ---------------------------------------------------------------------------
// ERC20 minimal — identique partout
// ---------------------------------------------------------------------------
export const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];

// ---------------------------------------------------------------------------
// Helpers d'affichage
// ---------------------------------------------------------------------------
export const txUrl = (h) => `${CHAIN.explorer}/tx/${h}`;
export const addrUrl = (a) => `${CHAIN.explorer}/address/${a}`;

/** true si l'actif de paiement est l'actif natif de la chaine (ETH). */
export const feeIsNative = () => !PONS.feeAsset;
