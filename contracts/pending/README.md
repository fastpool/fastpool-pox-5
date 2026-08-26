# `contracts/pending/`

Contracts that are written and reviewed but **not in the Clarinet build**, and
therefore **not type-checked**. Nothing here is deployed by
`scripts/build-mainnet.mjs`.

A contract sits here when it targets something that does not exist on chain yet.
Every other adapter in `contracts/` is checked against the real mainnet ABI it
calls, because Clarinet can pull those in as `requirements`. That is not
possible for a contract that has not been published, and inventing a stub to
check against would only verify a transcription of the source rather than the
source itself.

## `dex-adapter-jing-juice.clar`

Taker path into Jing's Juice batch auction, sBTC -> STX.

**Blocked on:** `markets-sbtc-stx-jing-v2` and `jing-core-v3` are not deployed.
The sources are at github.com/Rapha-btc/jing-contracts-v3; the expected mainnet
principal, taken from `JING-MARKET` in the authors' own `vault-sbtc-stx-v2.clar`,
is `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v2` -- but
that address is an expectation, not a fact, until the deployment happens.

**What has been verified** without the contract being on chain:

- The `swap` signature, the argument order and the `deposit-x` direction come
  from the v3 source, cross-checked against `vault-sbtc-stx-v2.clar`, which is
  the authors' own reference integration of this exact call.
- The token traits and asset-name strings (`"sbtc-token"`, `"wstx"`) are
  likewise taken from that integration, not guessed.
- The taker-rebate arithmetic behind the limit price is derived from
  `TAKER_REBATE_BPS` and the settlement conversion in the market source.
- The manager side -- `swap-rewards-with-proof`, the `dex-adapter-proof-trait`
  and the bounded STX allowance for the oracle-refresh fee -- **is** in the
  build and is covered by `tests/stx-rewards.test.ts` against
  `mock-dex-adapter`, which implements the same trait.

**What has not been verified:** that this compiles against the real market, and
the deployment address.

Vendoring the market to type-check against it was tried and reverted: it needs
the Pyth and Wormhole contracts as requirements, and that dependency tree pushed
`clarinet check` past ten minutes without completing. Trading a one-minute build
for an unusable one, to check a forty-line adapter against a contract that is
not deployed anyway, was not worth it.

## Promoting it

Once Juice v3 is on mainnet:

1. Add the market as a Clarinet `requirement` and confirm the principal.
2. Move the file to `contracts/`, add a `[contracts.dex-adapter-jing-juice]`
   entry (Clarity 6, epoch 4.0), and replace the `.markets-sbtc-stx-jing-v2`
   sugar with the confirmed principal -- or keep the sugar and let
   `scripts/build-mainnet.mjs` rewrite it; the rewrite is already written.
3. `clarinet check` -- this is the step that has been missing.
4. Add it to `SUITE` in `scripts/build-mainnet.mjs` and to `MAINNET_ONLY` in
   `scripts/deploy.mjs`.
5. Deploy, `set-dex-adapter <adapter> true`, and take a deliberately tiny first
   leg (see `docs/deploy-stx-rewards.md` section 8).
