// Faux nœud Arc : simule des holders, des trades et des creator funds.
import http from "http";
import { ethers } from "ethers";

const TOKEN   = "0x1111111111111111111111111111111111111111";
const PORTAL  = "0xB021Be536808f551b31789422Fd28a6c9c6e97Da";
const SPLITTER= "0x2222222222222222222222222222222222222222";
const LOCKER  = "0x3333333333333333333333333333333333333333";
const HOOK    = "0x4444444444444444444444444444444444444444";
const USDC    = "0x3600000000000000000000000000000000000000";
const POOLMGR = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const CREATOR = process.env.MOCK_CREATOR;

const iface = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const TOPIC = iface.getEvent("Transfer").topicHash;

let head = 1000;
const logs = [];           // {blockNumber, from, to, value}
let credited = 0n;         // creator funds en attente chez Argus
let sentTxs = [];

// 30 holders qui achètent au pool, tailles variées
const holders = [];
for (let i = 0; i < 30; i++) {
  const w = ethers.Wallet.createRandom().address;
  const pct = i === 0 ? 4000 : i < 4 ? 800 : i < 12 ? 200 : 40; // bps de supply
  holders.push({ addr: w, bps: pct });
}
const SUPPLY = 1000000000n * 10n ** 18n;
for (const h of holders) {
  logs.push({ blockNumber: ++head, from: POOLMGR, to: h.addr, value: (SUPPLY * BigInt(h.bps)) / 10000n });
}
// bruit : contrats du launch qui doivent être exclus
logs.push({ blockNumber: ++head, from: POOLMGR, to: LOCKER, value: SUPPLY / 10n });

// toutes les 3s, de nouveaux trades génèrent des creator funds
setInterval(() => { head += 3; credited += 60_000_000n; }, 300);

function encAddr(a){ return ethers.zeroPadValue(a, 32).slice(2); }
function hexnum(n){ return "0x" + n.toString(16); }

function handleCall(to, data) {
  const sel = data.slice(0, 10);
  // launches(address)
  if (to.toLowerCase() === PORTAL.toLowerCase()) {
    return "0x" + [
      encAddr(CREATOR),
      ethers.toBeHex(0, 32).slice(2),      // tickStart
      ethers.toBeHex(1, 32).slice(2),      // tokenIsToken0
      encAddr(LOCKER), encAddr(HOOK), encAddr(SPLITTER),
      ethers.toBeHex(500, 32).slice(2),    // buyTaxBps
      ethers.toBeHex(500, 32).slice(2),    // sellTaxBps
      ethers.toBeHex(1, 32).slice(2),      // positionId
      ethers.toBeHex(0, 32).slice(2),      // tickBond
      encAddr(USDC),
    ].join("");
  }
  // creditedToCreator(address)
  if (to.toLowerCase() === SPLITTER.toLowerCase()) {
    if (sel === ethers.id("creditedToCreator(address)").slice(0,10))
      return ethers.toBeHex(credited, 32);
    return "0x";
  }
  return "0x" + ethers.toBeHex(0, 32).slice(2);
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    const reqs = JSON.parse(body);
    const arr = Array.isArray(reqs) ? reqs : [reqs];
    const out = arr.map(r => {
      const { method, params, id } = r;
      let result;
      switch (method) {
        case "eth_chainId": result = "0x13b2"; break;
        case "eth_blockNumber": result = hexnum(head); break;
        case "net_version": result = "5042"; break;
        case "eth_getBlockByNumber": {
          const p = params[0];
          const n = (p === "latest" || p === "pending" || p === "safe" || p === "finalized")
            ? head : parseInt(p, 16);
          result = { number: hexnum(n), hash: ethers.keccak256(ethers.toUtf8Bytes("blk" + n)),
                     parentHash: ethers.ZeroHash, timestamp: hexnum(1758000000 + n),
                     difficulty:"0x0", nonce:"0x0000000000000000", extraData:"0x", gasLimit:"0x1c9c380", gasUsed:"0x0", miner: ethers.ZeroAddress,
                     baseFeePerGas:"0x1", transactions: [] };
          break;
        }
        case "eth_getLogs": {
          const f = parseInt(params[0].fromBlock, 16), t = parseInt(params[0].toBlock, 16);
          result = logs.filter(l => l.blockNumber >= f && l.blockNumber <= t).map((l, i) => ({
            address: TOKEN, blockNumber: hexnum(l.blockNumber),
            blockHash: ethers.keccak256(ethers.toUtf8Bytes("blk" + l.blockNumber)),
            transactionHash: ethers.keccak256(ethers.toUtf8Bytes("tx" + l.blockNumber + i)),
            transactionIndex: "0x0", logIndex: hexnum(i), removed: false,
            topics: [TOPIC, ethers.zeroPadValue(l.from, 32), ethers.zeroPadValue(l.to, 32)],
            data: ethers.toBeHex(l.value, 32),
          }));
          break;
        }
        case "eth_call": result = handleCall(params[0].to, params[0].data || "0x"); break;
        case "eth_getTransactionCount": result = hexnum(sentTxs.length); break;
        case "eth_estimateGas": result = "0x15f90"; break;
        case "eth_gasPrice": result = "0x3b9aca00"; break;
        case "eth_maxPriorityFeePerGas": result = "0x3b9aca00"; break;
        case "eth_feeHistory": result = { baseFeePerGas:["0x1","0x1"], gasUsedRatio:[0.5], oldestBlock: hexnum(head-1), reward:[["0x1"]] }; break;
        case "eth_sendRawTransaction": {
          const tx = ethers.Transaction.from(params[0]);
          const h = tx.hash; sentTxs.push({ hash: h, to: tx.to, data: tx.data });
          // si c'est le claim, on vide le crédit
          if (tx.to?.toLowerCase() === SPLITTER.toLowerCase()) { console.log("  [node] claim reçu"); credited = 0n; }
          else console.log("  [node] transfer USDC →", "0x" + tx.data.slice(34, 74));
          result = h; break;
        }
        case "eth_getTransactionReceipt": {
          const t = sentTxs.find(x => x.hash === params[0]);
          result = t ? { transactionHash: t.hash, blockNumber: hexnum(head), blockHash: ethers.keccak256(ethers.toUtf8Bytes("blk"+head)),
                         status:"0x1", gasUsed:"0x5208", cumulativeGasUsed:"0x5208", logs:[], logsBloom:"0x"+"0".repeat(512),
                         type:"0x2", from: ethers.ZeroAddress, to: t.to, contractAddress:null, transactionIndex:"0x0", effectiveGasPrice:"0x1" } : null;
          break;
        }
        default: result = null;
      }
      return { jsonrpc: "2.0", id, result };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(Array.isArray(reqs) ? out : out[0]));
  });
});
server.listen(8545, () => console.log("[node] faux Arc sur :8545 | token", TOKEN));
