// ===========================================================================
//  Faux nœud Robinhood Chain. Simule des holders, des fees qui s'accumulent
//  et un escrow Pons, pour voir tourner un cycle complet sans toucher au
//  mainnet.
//
//    MOCK_CREATOR=0xTonWalletDeTest node mocknode.mjs &
//
//  Puis lance le bot avec RPC_URL=http://127.0.0.1:8545
// ===========================================================================

import http from "http";
import { ethers } from "ethers";

const TOKEN = "0x1111111111111111111111111111111111111111";
const ESCROW = "0x2222222222222222222222222222222222222222";
const CURVE = "0x3333333333333333333333333333333333333333";
const CREATOR = process.env.MOCK_CREATOR;

if (!CREATOR) {
  console.error("usage: MOCK_CREATOR=0x… node mocknode.mjs");
  process.exit(1);
}

const iface = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const TOPIC = iface.getEvent("Transfer").topicHash;

let head = 1000;
const logs = [];
let pending = 0n; // fees en attente dans l'escrow
let botBalance = ethers.parseEther("0.05"); // le bot demarre avec du gas
let sentTxs = [];

const SUPPLY = 1_000_000_000n * 10n ** 18n;

// 30 holders de tailles variees + la bonding curve qui detient une grosse part
const holders = [];
for (let i = 0; i < 30; i++) {
  const bps = i === 0 ? 1200 : i < 4 ? 600 : i < 12 ? 180 : 30;
  holders.push({ addr: ethers.Wallet.createRandom().address, bps });
}
for (const h of holders) {
  logs.push({ blockNumber: ++head, from: CURVE, to: h.addr, value: (SUPPLY * BigInt(h.bps)) / 10000n });
}
// la curve garde le reste — doit etre exclue du tirage
logs.push({ blockNumber: ++head, from: ethers.ZeroAddress, to: CURVE, value: SUPPLY / 3n });

// Robinhood Chain est un L2 : blocs rapides. On simule 4 blocs/s et des
// fees qui tombent regulierement.
setInterval(() => {
  head += 4;
  pending += ethers.parseEther("0.004");
}, 1000);

const hexnum = (n) => "0x" + n.toString(16);
const blockHash = (n) => ethers.keccak256(ethers.toUtf8Bytes("rh-block-" + n));

const FACTORY_IFACE = new ethers.Interface([
  "function getLaunchedToken(address token) view returns (tuple(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
  "function getLaunchFeePolicy(address token) view returns (tuple(address protocolFeeRecipient, uint16 protocolFeeShareBps, uint16 buybackBurnBps, uint16 hookFeeBps, uint16 maxInternalPriceImpactBps))",
]);

function handleCall(to, data) {
  const sel = (data || "0x").slice(0, 10);
  // Factory Pons V2 (n'importe quelle adresse qui n'est ni le token, ni
  // l'escrow) : decrit le launch comme la vraie factory le ferait.
  if (sel === FACTORY_IFACE.getFunction("getLaunchedToken").selector) {
    return FACTORY_IFACE.encodeFunctionResult("getLaunchedToken", [
      [TOKEN, CURVE, CREATOR, CREATOR, ethers.ZeroAddress, ethers.parseEther("4.2"), 0, 200, 200, false, 1, 0, 0, 0, true],
    ]);
  }
  if (sel === FACTORY_IFACE.getFunction("getLaunchFeePolicy").selector) {
    return FACTORY_IFACE.encodeFunctionResult("getLaunchFeePolicy", [[ethers.ZeroAddress, 3000, 5000, 100, 300]]);
  }
  if (to?.toLowerCase() === ESCROW.toLowerCase()) {
    // PonsV2FeeEscrow : claim() paie msg.sender, revert NoBalance() si vide
    if (sel === ethers.id("claim()").slice(0, 10)) {
      if (pending === 0n) return { error: true };
      return ethers.toBeHex(pending, 32);
    }
    if (sel === ethers.id("balanceOf(address)").slice(0, 10)) {
      return ethers.toBeHex(pending, 32);
    }
    if (sel === ethers.id("creator()").slice(0, 10)) {
      return ethers.zeroPadValue(CREATOR, 32);
    }
    return { error: true };
  }
  if (to?.toLowerCase() === TOKEN.toLowerCase()) {
    if (sel === ethers.id("totalSupply()").slice(0, 10)) return ethers.toBeHex(SUPPLY, 32);
    if (sel === ethers.id("decimals()").slice(0, 10)) return ethers.toBeHex(18, 32);
    return ethers.toBeHex(0, 32);
  }
  return "0x" + ethers.toBeHex(0, 32).slice(2);
}

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reqs = JSON.parse(body);
      const arr = Array.isArray(reqs) ? reqs : [reqs];
      const out = arr.map((r) => {
        const { method, params, id } = r;
        let result;
        switch (method) {
          case "eth_chainId":
            result = "0x1237"; // 4663
            break;
          case "net_version":
            result = "4663";
            break;
          case "eth_blockNumber":
            result = hexnum(head);
            break;
          case "eth_getBalance": {
            // mock : un seul acteur, on renvoie toujours le solde du bot
            result = ethers.toBeHex(botBalance, 32);
            break;
          }
          case "eth_getBlockByNumber": {
            const pn = params[0];
            const n = ["latest", "pending", "safe", "finalized"].includes(pn) ? head : parseInt(pn, 16);
            result = {
              number: hexnum(n),
              hash: blockHash(n),
              parentHash: blockHash(n - 1),
              timestamp: hexnum(1758000000 + Math.floor(n / 4)),
              difficulty: "0x0",
              nonce: "0x0000000000000000",
              extraData: "0x",
              gasLimit: "0x1c9c380",
              gasUsed: "0x0",
              miner: ethers.ZeroAddress,
              baseFeePerGas: "0x1",
              transactions: [],
            };
            break;
          }
          case "eth_getLogs": {
            const f = parseInt(params[0].fromBlock, 16),
              t = parseInt(params[0].toBlock, 16);
            result = logs
              .filter((l) => l.blockNumber >= f && l.blockNumber <= t)
              .map((l, i) => ({
                address: TOKEN,
                blockNumber: hexnum(l.blockNumber),
                blockHash: blockHash(l.blockNumber),
                transactionHash: ethers.keccak256(ethers.toUtf8Bytes("tx" + l.blockNumber + i)),
                transactionIndex: "0x0",
                logIndex: hexnum(i),
                removed: false,
                topics: [TOPIC, ethers.zeroPadValue(l.from, 32), ethers.zeroPadValue(l.to, 32)],
                data: ethers.toBeHex(l.value, 32),
              }));
            break;
          }
          case "eth_call": {
            const v = handleCall(params[0].to, params[0].data);
            if (v && v.error) {
              return { jsonrpc: "2.0", id, error: { code: 3, message: "execution reverted", data: "0x" } };
            }
            result = v;
            break;
          }
          case "eth_getCode":
            result = [ESCROW.toLowerCase(), CURVE.toLowerCase(), TOKEN.toLowerCase()].includes(
              params[0]?.toLowerCase()
            )
              ? "0x60006000"
              : "0x";
            break;
          case "eth_getTransactionCount":
            result = hexnum(sentTxs.length);
            break;
          case "eth_estimateGas":
            result = "0x15f90";
            break;
          case "eth_gasPrice":
          case "eth_maxPriorityFeePerGas":
            result = "0x3b9aca00";
            break;
          case "eth_feeHistory":
            result = {
              baseFeePerGas: ["0x1", "0x1"],
              gasUsedRatio: [0.5],
              oldestBlock: hexnum(head - 1),
              reward: [["0x1"]],
            };
            break;
          case "eth_sendRawTransaction": {
            const tx = ethers.Transaction.from(params[0]);
            sentTxs.push({ hash: tx.hash, to: tx.to });
            if (tx.to?.toLowerCase() === ESCROW.toLowerCase()) {
              console.log(`  [node] claim recu, ${ethers.formatEther(pending)} ETH verses au bot`);
              botBalance += pending;
              pending = 0n;
            } else if (tx.value > 0n) {
              botBalance -= tx.value;
              console.log(`  [node] payout ${ethers.formatEther(tx.value)} ETH -> ${tx.to}`);
            }
            result = tx.hash;
            break;
          }
          case "eth_getTransactionReceipt": {
            const t = sentTxs.find((x) => x.hash === params[0]);
            result = t
              ? {
                  transactionHash: t.hash,
                  blockNumber: hexnum(head),
                  blockHash: blockHash(head),
                  status: "0x1",
                  gasUsed: "0x5208",
                  cumulativeGasUsed: "0x5208",
                  logs: [],
                  logsBloom: "0x" + "0".repeat(512),
                  type: "0x2",
                  from: CREATOR,
                  to: t.to,
                  contractAddress: null,
                  transactionIndex: "0x0",
                  effectiveGasPrice: "0x1",
                }
              : null;
            break;
          }
          default:
            result = null;
        }
        return { jsonrpc: "2.0", id, result };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(Array.isArray(reqs) ? out : out[0]));
    });
  })
  .listen(8545, () =>
    console.log(`[node] faux Robinhood Chain sur :8545
  token  ${TOKEN}
  escrow ${ESCROW}
  curve  ${CURVE}   (a exclure)
  creator ${CREATOR}
`)
  );
