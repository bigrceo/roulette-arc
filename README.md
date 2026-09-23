# $ROULETTE

Every trade feeds a pot. When the pot hits the threshold, one holder takes all
of it. The winner is drawn from the hash of a block that had not been mined at
the time the draw was announced.

Live on [Robinhood Chain](https://robinhoodchain.blockscout.com) (chain id
4663, an Arbitrum rollup), launched through [Pons](https://www.ponsfamily.com).
Site: [rouletteonchain.world](https://rouletteonchain.world) · X: [@getroulette](https://x.com/getroulette).

**This repo exists so you don't have to trust the operator.** The draw logic
here is the exact code the bot runs, and `verify.js` lets anyone recompute any
past winner straight from the chain.

---

## How a round works

1. Trades pay a fee. Pons credits the creator's share to its fee escrow and
   keeps its own share first. What reaches this project is what is left after
   that — see [What Pons actually does with the fee](#what-pons-actually-does-with-the-fee).
2. The bot collects it. `POT_SHARE`% (70) goes to the pot, the rest funds the
   project. Both numbers are published on the site.
3. When the pot reaches the threshold, a **draw block** is announced —
   `DRAW_DELAY_BLOCKS` blocks in the future. The site shows it immediately.
4. Once that block is mined, holder balances are frozen **at that exact block**
   and its hash selects the winner.
5. The pot is transferred. The transaction hash is published.

Nobody can predict the hash of an unmined block, the operator included. Once
the block number is public, nothing about the draw can be changed.

### Odds

Weight is the **square root** of your balance, not the balance itself.

Measured over 40,000 simulated draws: a wallet holding 60% of supply wins 47.6%
of draws; a holder at 2% wins 8.7%. Holding 4x more gives you 2x the odds, not
4x. Large holders still win more often — they just don't win everything, which
is what kills these mechanics for everyone else.

Wallets below 0.1% of supply are not eligible. Excluded from every draw: the
Pons bonding curve, the Uniswap v4 pool manager, the Pons locker, buyback
vault, hook, fee escrow, factory, the bot wallet and the burn addresses. The
curve address is read from the Pons factory at startup, not typed by hand.

---

## Verify a round yourself

```bash
npm install

TOKEN_ADDRESS=0x… DEPLOY_BLOCK=… node verify.js 3
```

It replays every `Transfer` event up to the draw block, rebuilds the balances,
asks the Pons factory which contract is the bonding curve and who receives the
creator fees (both excluded, same as the bot), reads the block hash from the
chain, recomputes the winner and compares against what was published.

`verify.js` and the bot both import the same `lib.js`, so the two cannot drift
apart — even if the rules change later.

Run the logic tests with `npm test`: 31 assertions, no network needed.

---

## What Pons actually does with the fee

Read on-chain on 2026-09-22 from the verified contracts, not from the docs:

| | |
|---|---|
| Factory | `PonsV2LaunchFactory` [`0x7eD5…EC7e`](https://robinhoodchain.blockscout.com/address/0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e) |
| Fee escrow | `PonsV2FeeEscrow` [`0xd3AF…Ac9e`](https://robinhoodchain.blockscout.com/address/0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e), one contract for every token |
| Withdrawal | `claim()` for an ETH-paired launch, `claimToken(pairToken)` otherwise. Pays `msg.sender`. Reverts `NoBalance()` when empty. |
| Who gets paid | the launch's `creatorFeeRecipient` — the wallet that launched the token, so the bot wallet **is** the launch wallet |
| Creator tax | `creatorTaxBps = 200` (2% of each trade) on the launches we inspected |
| Protocol cut | `protocolFeeShareBps = 3000` in the fee policy. In the escrow credits we sampled, Pons' recipient received roughly 10–15% of each credit and the creator the rest. |
| Graduation | 4.2 ETH on the curve (ETH pairing), then a Uniswap v4 pool. Fees keep flowing to the same escrow after graduation, via the hook. |
| Block time | 0.101 s measured over 2,000 blocks. `DRAW_DELAY_BLOCKS=1800` ≈ 3 minutes. |

So the honest sentence is: **70% of what reaches the bot wallet goes to the
pot.** Not 70% of the tax. Pons takes its share before anything reaches us,
and the exact ratio is theirs to change.

`npm run probe` on any Pons token prints all of the above for that token.

### Pairing asset

The pot is denominated in the launch's pairing asset. Pons approves several:
native ETH (most launches), USDG (Global Dollar, 6 decimals, a few hundred
launches), and tokenized stocks. The bot handles both native and ERC20: set
`FEE_ASSET` / `FEE_DECIMALS` for an ERC20 pairing. At startup it checks the
pairing against the factory and refuses to claim if they disagree.

---

## On block hashes and rollups

Robinhood Chain is an Arbitrum rollup. Blocks are produced by a centralized
sequencer rather than by a decentralized consensus.

What this does and does not mean:

- The operator of this bot **cannot** predict or influence the hash of a block
  announced in advance. That part of the guarantee holds.
- The randomness is **not** consensus-grade. A sequencer with the motivation to
  do so has more leverage over block contents than a validator set would.

Stated here rather than buried, because the whole point of the project is that
you check rather than trust.

---

## Running it

Needs a **dedicated wallet**, funded with ETH — that is the gas token on
Robinhood Chain. **Launch the token from that same wallet**: Pons pays creator
fees to the launching wallet and the bot claims as itself.

```bash
npm install

PRIVATE_KEY=0x…          # dedicated wallet, never a main one — the launch wallet
TOKEN_ADDRESS=0x…
DEPLOY_BLOCK=…           # block of the creation tx (npm run probe prints it)
RPC_URL=https://rpc.mainnet.chain.robinhood.com
FEE_ASSET=               # empty for ETH; 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 for USDG
FEE_DECIMALS=18          # 6 for USDG
POT_SHARE=70
THRESHOLD=0.02
GAS_RESERVE=0.003
DRAW_DELAY_BLOCKS=1800
TICK_SECONDS=30

npm start
```

Factory and escrow addresses default to the real Pons V2 contracts in
`chain.js`; `PONS_FACTORY` / `PONS_ESCROW` override them if Pons migrates.

Without `TOKEN_ADDRESS` it serves the site in pre-launch mode and waits.

On startup it prints the chain ID (expect **4663**), the curve it excluded,
the pairing asset and whether the fee recipient is the bot wallet. If either
of the last two is wrong it says so and does not claim.

`mocknode.mjs` is a fake Robinhood Chain node (same escrow and factory
signatures as the real ones) for testing the full cycle locally:

```bash
MOCK_CREATOR=<bot address> node mocknode.mjs &
PRIVATE_KEY=<test key> TOKEN_ADDRESS=0x1111111111111111111111111111111111111111 \
DEPLOY_BLOCK=1000 RPC_URL=http://127.0.0.1:8545 \
PONS_ESCROW=0x2222222222222222222222222222222222222222 \
THRESHOLD=0.03 GAS_RESERVE=0.005 DRAW_DELAY_BLOCKS=4 TICK_SECONDS=2 npm start
```

---

## The site

`public/` is the whole site: one `index.html` (markup, styles and page script
inline), the roulette wheel, and two generated images. It is served two ways
from the same folder — by `index.js` on `npm start`, and as a static deploy on
Vercel with `/api/*` rewritten to the Railway bot. A push on `main` redeploys
both; there is no manual deploy step.

### The 3D hero

The wheel is real geometry, not a video: bowl, pocket ring, frets, cone,
turret and ball are built in code with Three.js, lit by one key spotlight and
two coloured rim lights, and finished with a discreet bloom on the gold. There
is no downloaded model and no downloaded texture — the wood grain and the
number ring are drawn into canvases at startup — so nothing here carries a
licence to cite.

It follows the round: `window.ROULETTE.setState('idle' | 'locked' | 'paid')`.
Idle the wheel turns slowly and the ball rolls; locked (a draw block is
announced) it speeds up; paid the ball drops, bounces down the cone and settles
into a pocket. The page calls it from `/api/state` on every poll.

Two files, on purpose:

| | |
|---|---|
| `wheel.js` | the loader. Checks for WebGL, then imports the core dynamically. |
| `wheel-core.js` | the wheel itself. Free to throw — the loader catches it. |

Anything that stops the wheel — no WebGL, a refused context, an unreachable
CDN, a browser without import maps — lands on `public/wheel-poster.jpg` in the
same frame, logged as `console.info`, never as a red error. `window.ROULETTE`
stays callable as a no-op so the page script does not have to care.

What keeps it cheap: an `IntersectionObserver` on `#wheel-3d` stops the loop
outright once the hero is off screen (zero frames, draw calls frozen), the tab
being hidden does the same, and under 700px the bloom pass is dropped — 116
draw calls per frame instead of 129. `prefers-reduced-motion` renders a single
still image and never starts the loop.

### Bumping `?v=`

`index.html` loads the hero as `/wheel.js?v=N`, and the loader passes its own
`?v=` straight to `wheel-core.js`, so one number covers both files. **Raise `N`
in `index.html` every time you touch either file** — the static server and
Vercel both serve `public/` assets with `Cache-Control: max-age=3600`, so
without a bump a visitor keeps the old wheel for an hour. `public/og.html`
carries its own copy of the same reference; keep the two in step.

### Captures and measurements

Chromium only — `npm install` first, the dev tooling (Playwright, axe-core,
sharp, and a local copy of three for offline runs) lives in `devDependencies`
and nothing was added to the runtime, where `ethers` is still the only
dependency.

```bash
npm run shots   # shots/ : idle, locked, paid, pre-launch, no-WebGL, no import map
                #          in 1280x800 and 375x812
npm run perf    # draw calls per frame, and proof the loop stops off screen
npm run a11y    # axe-core over the live page and the pre-launch page
npm run og      # regenerates public/wheel-poster.jpg and public/og.png
```

`shots/` is gitignored. `npm run shots` boots `mocknode.mjs` and two servers by
itself, so it needs nothing running beforehand; it lowers the threshold to
0.05 so the locked state arrives in under a minute.

`npm run og` renders `public/og.html` — a 1200x630 page that is deliberately
not linked from the navigation and exists only to be photographed. It reuses
the site's variables, fonts and wheel module, so the share image cannot drift
away from the site. It refuses to write `og.png` if the Google fonts did not
load, and re-encodes the result to a 256-colour palette to stay under 400 KB.

### The pinned CDN

Three.js is loaded from jsDelivr through an import map, pinned to
`three@0.170.0` for both `three` and `three/addons/`. Pinned rather than
floating on purpose: the addons (`EffectComposer`, `UnrealBloomPass`,
`OutputPass`, `RoomEnvironment`) track the core's internals and a minor bump
has broken that pairing before. If you raise the version, raise it in both
entries of the import map **and** in `public/og.html`, then run `npm run shots`
and look at the hero before pushing. A CDN that does not answer is not fatal —
the loader falls back to the poster.

---

## Posts on X

With `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN` and `X_ACCESS_SECRET` set,
the bot posts from [@getroulette](https://x.com/getroulette) at three moments:
the pot passing half of the threshold, the draw block being announced, and the
payout landing (with the transaction link). Each post is recorded in
`state.json` so a restart never reposts. A failed post is logged and skipped;
it never delays a draw. `X_DRY_RUN=true` prints the posts instead of sending
them. Templates live in `x.js` and can be overridden with
`X_TEMPLATE_ANNOUNCE`, `X_TEMPLATE_RESULT`, `X_TEMPLATE_HALF`.

---

## Accounting

The bot does not measure a balance delta around a transaction. That approach is
fragile: gas leaves the same balance when fees are paid in ETH, an RPC can
serve a value from an earlier block, and a half-failed claim corrupts the
count.

Instead it looks at **what is actually available** on each tick and splits
whatever arrived, regardless of where it came from. A falling balance never
produces a negative entry. A gas reserve is always kept back so the bot can
still pay future winners.

---

## Known limitations

Stated plainly, because a mechanic like this is only worth anything if you know
where it bends.

**Splitting across wallets.** With square-root weighting, `√a + √b > √(a+b)`. A
large holder can split a position across wallets to raise their odds. The 0.1%
minimum limits how far this goes and gas makes it tedious, but the hole is
real. No weighting scheme closes it without identity.

**Nothing locks a winner in.** A holder can sell right after a draw.

**The bot holds a hot key.** It is a dedicated wallet holding only what is
needed, but the key lives on a server. Treat that wallet as expendable.

**Sequencer-produced blocks.** See the section above.

**Pons sets the fee.** The creator tax and the protocol cut are Pons
parameters. If they change, the pot's inflow changes. The site never states a
percentage of the trade, only the split of what arrives.

**Regulatory framing.** A prize draw tied to holding a token may fall under
gambling rules in some jurisdictions. Not legal advice.

---

## Files

| | |
|---|---|
| `chain.js` | everything specific to Robinhood Chain and Pons — real addresses, ABIs, launch discovery |
| `lib.js` | draw logic — eligibility, weighting, selection, accounting |
| `index.js` | bot and web server |
| `probe.js` | on-chain inspection of any Pons launch |
| `verify.js` | independent round verification |
| `test.mjs` | logic tests, no network |
| `mocknode.mjs` | fake node for local testing |
| `x.js` | posts on X, OAuth 1.0a without dependencies |
| `public/` | the site — see [The site](#the-site). `wheel.js` loads `wheel-core.js`, the procedural Three.js wheel in the hero, driven by the round state (idle, locked, paid) |
| `scripts/` | captures, performance, accessibility and image generation — dev only, never shipped |

---

Memecoins are highly speculative. Nothing here is financial advice.
