# $ROULETTE

Every trade feeds a pot. When the pot hits the threshold, one holder takes all
of it. The winner is drawn from the hash of a block that has not been mined at
the time the draw is announced.

Live on [Arc](https://explorer.arc.io), settled in USDC, launched through
[Argus](https://argus.world).

**This repo exists so you don't have to trust the operator.** The draw logic
here is the exact code the bot runs, and `verify.js` lets anyone recompute any
past winner straight from the chain.

---

## How a round works

1. Buys and sells pay a 5% tax. It lands in the launch's revenue contract on
   Argus, in USDC.
2. The bot claims it. `POT_SHARE`% goes to the pot, the rest funds the project.
   Both numbers are published on the site.
3. When the pot reaches `THRESHOLD_USDC`, a **draw block** is announced —
   `DRAW_DELAY_BLOCKS` blocks in the future. The site shows it immediately.
4. Once that block is mined, holder balances are frozen **at that exact block**
   and the winner is picked from the block hash.
5. The pot is transferred in USDC. The transaction hash is published.

Nobody can predict the hash of an unmined block, the operator included. And
once the block number is public, nothing about the draw can be changed.

### Odds

Weight is the **square root** of your balance, not the balance itself.

Holding 4x more gives you 2x the odds, not 4x. Large holders still win more
often — they just don't win everything, which is what kills these mechanics for
everyone else. Wallets below 0.1% of supply are not eligible. Pool, hook,
locker, splitter and the bot wallet are excluded.

---

## Verify a round yourself

```bash
npm install

TOKEN_ADDRESS=0x… \
DEPLOY_BLOCK=… \
EXCLUDED=0xlocker,0xhook,0xsplitter,0xbot \
node verify.js 3
```

It replays every `Transfer` event up to the draw block, rebuilds the balances,
reads the block hash from the chain and recomputes the winner. It then compares
against what was published.

`verify.js` and the bot both import the same `lib.js`, so the two cannot drift
apart — even if the rules change later.

Run the logic tests with `npm test` (20 assertions, no network needed).

---

## Inspect any Argus launch

`probe.js` reads a token's on-chain configuration. Read-only, no private key:

```bash
TOKEN_ADDRESS=0x… node probe.js
```

It reports the portal, creator, splitter, hook, locker, tax rates and quote
asset, then probes which functions the revenue splitter actually exposes.

Useful on any Argus token, not just this one.

---

## Notes on the Argus ABI

The public Argus repo describes itself as a simplified reconstruction, and it
does differ from the deployed Portal #7. Probed against a real token:

| Function | Result |
|---|---|
| `launches(address)` | matches the repo |
| `claim(address)` | **one argument**, not two |
| `creator()`, `liquidityBps()` | present |
| `creditedToCreator()`, `creatorFundsBps()`, `buybackBurnBps()`, `dividendsBps()` | **absent under those names** |

The bot depends on none of the missing getters. It simulates `claim()` to know
whether anything is pending, then measures the amount by the change in its own
USDC balance. Measuring beats guessing function names.

---

## Running it

Needs a **dedicated wallet** — `claim()` is creator-only, so the bot must hold
the key of the address that launched the token. Never a main wallet.

Argus settings at launch: 5% buy, 5% sell, creator funds 100%, everything else
0. The 100% is not extraction: Argus offers four fixed destinations and native
dividends only pay pro-rata in USDC. Taking creator funds is the only way to
run a custom mechanic, and this repo is what happens to the money afterwards.

```bash
npm install

PRIVATE_KEY=0x…          # creator wallet
TOKEN_ADDRESS=0x…
DEPLOY_BLOCK=…           # block of the creation tx
ARC_RPC_URL=https://rpc.mainnet.arc.io
POT_SHARE=70
THRESHOLD_USDC=50
DRAW_DELAY_BLOCKS=20
TICK_SECONDS=30

npm start
```

Without `TOKEN_ADDRESS` it serves the site in pre-launch mode and waits.

On startup it prints the chain ID (expect **5042**) and warns if the bot wallet
is not the token creator — in which case `claim()` will fail.

`mocknode.mjs` is a fake Arc node for testing the full cycle locally without
touching mainnet.

---

## Known limitations

Stated plainly, because a mechanic like this is only worth anything if you know
where it bends.

**Splitting across wallets.** With square-root weighting, `√a + √b > √(a+b)`. A
large holder can split a position across wallets to raise their odds. The 0.1%
minimum limits how far this goes and gas makes it tedious, but the hole is
real. No weighting scheme closes it without identity.

**Nothing locks a winner in.** A holder can sell right after a draw.

**The bot holds a hot key.** It claims shortly before each draw to limit
exposure, but the key lives on a server. Treat the wallet as expendable.

**Regulatory framing.** A prize draw tied to holding a token may fall under
gambling rules in some jurisdictions. Not legal advice.

---

## Files

| | |
|---|---|
| `lib.js` | draw logic — eligibility, weighting, selection |
| `index.js` | bot and web server |
| `verify.js` | independent round verification |
| `probe.js` | on-chain inspection of any Argus launch |
| `test.mjs` | logic tests, no network |
| `mocknode.mjs` | fake Arc node for local testing |
| `public/` | the site |

---

Memecoins are highly speculative. Nothing here is financial advice.
