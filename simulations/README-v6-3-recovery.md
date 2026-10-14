# Fastpool: cancel-only recovery against Jing v6-3

Verified 2026-09-23: **665/665 checks green** — recovery matrix **569/569**, existing regression suites **96/96**. No production contract edits; fork transactions only.

## Recovery matrix

Each inventory shape runs in four modes: normal, no oracle update supplied, market paused, and core-v6 paused. The normal mode also omits the update; the separately labelled no-update mode repeats the case explicitly. Signed Lazer data is used only to create or settle fixture orders, never during recovery.

The fixtures create pending escrow by calling `jing-place` with a nonempty opposite book. Resting, parked, pending plus resting, and no market position are tested separately. Every recovery checks exact returned sBTC, zero vault balance, empty pending/live/parked state, and `u1030` on a later settle. Pending refunds must emit the committed core event with reason `cancel` and the exact escrow amount. Paused cases also assert the pause remains set.

The actual pool calls `recover-swap-vault` with the vault trait. Its dynamic call invokes **`emergency-recover()` with no arguments**, checking conformance against the live shared trait. Direct unauthorized calls to the vault are refused. The pool receives the exact recovered total.

| Inventory | Recovery caller | N/M, including setup | Fork |
| --- | --- | ---: | --- |
| pending | pool | 113/113 | [stxer](https://stxer.xyz/simulations/mainnet/dcffa122fe861e84f2027d646235783a) |
| resting | pool | 102/102 | [stxer](https://stxer.xyz/simulations/mainnet/bdaabc36b73a23565d739f33ba51a353) |
| parked | pool | 131/131 | [stxer](https://stxer.xyz/simulations/mainnet/ac8ec18ad72211461efad945884c11e7) |
| pending+resting | pool | 125/125 | [stxer](https://stxer.xyz/simulations/mainnet/b5c2e92dfc22da04fa0d8fa4d3f0caca) |
| none | pool | 98/98 | [stxer](https://stxer.xyz/simulations/mainnet/bfbc6a6c2a26a4d6e50ed71dd1758167) |

[Machine-checked recovery report](results/v6-3-recovery/fastpool.json).

## Existing regression reruns

| Harness / mode | N/M | Fork | Saved evidence |
| --- | ---: | --- | --- |
| fastpool-deployment-guards | 22/22 | [stxer](https://stxer.xyz/simulations/mainnet/ba665690ace97352d1b5a2d1913e3291) | [JSON](results/pool-vault-stx/fastpool-deployment-guards.json) |
| fastpool-liquidation | 39/39 | [stxer](https://stxer.xyz/simulations/mainnet/40a3b9c7d02a7710a3258de8b816ce8a) | [JSON](results/pool-vault-stx/fastpool-liquidation.json) |
| fastpool-maker | 35/35 | [stxer](https://stxer.xyz/simulations/mainnet/56d0c6f8b9add6d59062821ffcf9a7f3) | [JSON](results/pool-vault-stx/fastpool-maker.json) |

The older cross-vault dust diagnostic was also updated and rerun: **68/68**, [stxer](https://stxer.xyz/simulations/mainnet/a20fb1c3f33b68ed3593b266dfffdedb), [JSON](results/dust-vaults/v6-3.json) (rerun on the current vault sources; first run [7f59141b](https://stxer.xyz/simulations/mainnet/7f59141b60e936923aab06d61902914f)). Including it, this repository records **733/733** checks. It exercises test copies of all three vaults at 1, 500, 1,000 and 2,000 sats. The 1-sat trades return `u16047` (`ERR_BELOW_FLOOR`, since the L-1 partial-sale fix; `u3002` before) and retain the sat; the larger trades fill and leave zero sBTC. `is-empty` intentionally considers up to 2 sats dust. This diagnostic rebinds pool authority to the test sender; CCD016 uses a restricted test-sender DAO gate, a real token donation, and a batch-clock fixture. It is separate from the exact-source pool/DAO integration matrix.

## Fork setup and limits

Every recovery fork deploys the unmodified sibling Jing sources under `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22`: `jing-core-v6` → `jing-ladder-v1` → `markets-sbtc-stx-jing-v6-3` → `swap-router-sbtc-stx-jing-v5-3`. It syncs the ladder seats, verifies the market in core, then initializes it with sBTC/STX traits, minimums 1,000 sats / 1,000,000 µSTX, and feed IDs 1 / 45. Market initialization registers with core. The vault and pool (CCD016: book and vault) are then deployed from this repository.

The primary matrix uses real fork token transfers. PoX earned rewards and mirrored pool shares are seeded in storage; creating locks and signer registration are outside this test. The vault funding clock is aged with an explicit Eval (433 burn blocks for the pools, 288 for CCD016); Fastpool’s settlement deadline is also aged. This tests the recovery gate on elapsed state without expiring the signed update needed for fixture creation. It does not simulate days of independent market activity.

Parking is reached through the public ladder seat-reservation setter and a larger publicly submitted and settled entrant. The primary matrix does not rewrite market balances or order maps. CCD016’s DAO Extensions map enables only the actual vault and a sender-guarded proposal extension; this tests extension authorization and treasury flow, not governance voting.

Legacy regression fixtures retain their stated scope: earned rewards/shares, compressed burn-block intervals, and DAO/DIA fixtures. Juice’s upgrade suite also uses deliberately altered candidate authority and injected tranche/order state. The four legacy CCD016 scripts strip comments only from deployed Jing/vault sources, use canonical dependency names, and retain their simulated DAO implementation. The old oracle-staleness widening has been removed. Source hashes and fixture disclosures are saved with the reports.

Migration adjustments preserve scenario intent: deposit calls use submit’s current ABI; full-side placement/readmit tests explicitly settle; empty reclaim is idempotent. Two-chunk liquidation explicitly caps a chunk, because current `sweep-amount` drains a smaller balance in one call. Maker fills close the batch before finishing. Recovery continuity uses the current 432-block emergency delay. No recovery failure was hidden by changing a contract.

## Run

Requires the sibling `~/projects/jing-contracts-v3` checkout and its installed Node dependencies. `JING_SRC` can override its contracts directory. The Lazer helper uses the public route without `PYTH_API_KEY`. The default node is `http://77.42.3.101/stacks-api`; `STACKS_API_URL` overrides it.

```sh
node simulations/pool-vault-stx-stxer.mjs --recovery
node simulations/pool-vault-stx-stxer.mjs
node simulations/pool-vault-stx-stxer.mjs --maker
node simulations/pool-vault-stx-stxer.mjs --lifecycle
node simulations/dust-vaults-stxer.mjs
```

Vault recovery source base: `ab1de34`; Jing source checkout: `24f3e23`.

## Exact recovery-matrix source hashes

| Contract | SHA-256 |
| --- | --- |
| `jing-core-v6` | `53c9b38a46196f777b3c76f76152c172aa50c220e4e8e449d47cb6cd3fe9ab32` |
| `jing-ladder-v1` | `99a6e9f6db9305ebb29d938e69439c720e497bd38c53ec8b447c8c34c528a902` |
| `markets-sbtc-stx-jing-v6-3` | `04b0a7df781aec46124d40d3c73c68169aeed919fed155ec5bf12153bb0bfb85` |
| `swap-router-sbtc-stx-jing-v5-3` | `dfc8165bb846c1e6bb2a95f1e3ac87d3a22bce0e5f2a8f6618a499c8a03f8cae` |
| `fastpool-swap-vault` | `2f6d90f4fb14cff92cc4891bd2ab1f90f09156901a786299006e81534b536225` |
| `signer-manager-vault-stx-rewards` | `91db429775c07f36308699f5678ab044e51e195b4e3b8f59feffb97f0c10d89c` |

## Vault fixes (L-1, L-2, #6, #7), fork-tested

`simulations/vault-fixes-stxer.mjs`, on the current vault and Jing sources
(market `d1e3bbad`, router `dfc8165b`, core `67242f19`):

| scenario | stxer | checks |
|---|---|---|
| L-1 partial `router-swap`: 40,079 sold, 59,921 kept, next call sells 30,061; a zero-sale call reverts u16047 without burning the cooldown | [f856210f](https://stxer.xyz/simulations/mainnet/f856210f08c226b04426ac13b95e058f) | 48/48 |
| L-2 window cap (289 and 1008 refused u16033, 287 / 288 accepted) and #6 (a 2-sat funding closes, `finalize-swap-vault` `(ok u0)`, the next cycle funds) | [f63c0bdc](https://stxer.xyz/simulations/mainnet/f63c0bdc826a77b67cbbd2f05c215d87) | 45/45 |
| #7 market dust: `close-batch` reclaims a 1-sat market position and closes; 3 sats still refused u16043 (the fork lowers the market minimum to 1 sat to build it) | [bf5d1b27](https://stxer.xyz/simulations/mainnet/bf5d1b277b05e263601fcf4e922ae8ba) | 79/79 |

Reruns on the current sources: guards 22/22 ([7e2710bc](https://stxer.xyz/simulations/mainnet/7e2710bc1a29573770e4b34a629d2cfe)), maker 35/35 ([ee9a6d96](https://stxer.xyz/simulations/mainnet/ee9a6d963204aa4015a73226afffeaee)), lifecycle 41/41 ([798ad356](https://stxer.xyz/simulations/mainnet/798ad3562fd07f3a3b1e70e6e1a3db2f); a first run at 37/41 failed one chunk u16047 with the pools sitting right at the 1% floor), recovery matrix 569/569, dust-vaults 68/68.


## Rerun on the exact-rebate market (2026-09-30)

What changed:
- **Market** (jing-contracts-v3 `34bbe18`): `swap` sizes the rebate on the net,
  `net = floor(amount*10000/(10000+bps))`, `rebate = amount - net`. The unused rebate refunded is now only rounding.
  `gross-cap = net-cap==0 ? 0 : floor(((net-cap+1)*10020-1)/10000)`.
- **Router** (`6a84e02`): `jing-size` estimates `net = size*BPS/(BPS+20)`.
- **Vault** (`8436562`): the `router-swap` allowance is `amount + min-x + JING_REBATE_DUST_SATS` (u51).

Fork setup:
- `fastpool-swap-vault` and `signer-manager-vault-stx-rewards` are not on mainnet, so they keep their names.
- The sims already forked at the tip. `FORK_BLOCK` now pins the whole set to one height: **9093140**.

vault-fixes L-1 now funds **1,000,000 sats** (the default max chunk), up from 100,000.
- At this tip the book plus the AMMs could take all 100,000 inside the 40 bps floor, which left no rest.
- The test now checks the router's logged caps. Call 1 had capacity 40,085 + 0 + 0 + 411,119 = 451,204 < 1,000,000. It sold exactly that and kept 548,796.
- Call 2 sold 30,066 more. Call 3, with a 0 bps floor, reverted `u16047`.

No other expectation changed.

| sim | N/M | stxer |
|---|---:|---|
| guards | 22/22 | [2c87b1fdb926d12465a4f5968c170ebb](https://stxer.xyz/simulations/mainnet/2c87b1fdb926d12465a4f5968c170ebb) |
| maker | 35/35 | [482d34ad932dadbd38b45e8a4d129e71](https://stxer.xyz/simulations/mainnet/482d34ad932dadbd38b45e8a4d129e71) |
| lifecycle | 41/41 | [cf166f20eb79c14bf811f08f6d570bcd](https://stxer.xyz/simulations/mainnet/cf166f20eb79c14bf811f08f6d570bcd) |
| recovery matrix: pending | 569/569 in total | [97359d02625c0460b4aa49f8d71507f6](https://stxer.xyz/simulations/mainnet/97359d02625c0460b4aa49f8d71507f6) |
| recovery matrix: resting | | [5f313e33220911e3365cef31ee96d210](https://stxer.xyz/simulations/mainnet/5f313e33220911e3365cef31ee96d210) |
| recovery matrix: parked | | [c5c0dab948bf9b651a9aa0d3086a4581](https://stxer.xyz/simulations/mainnet/c5c0dab948bf9b651a9aa0d3086a4581) |
| recovery matrix: pending+resting | | [10434cb1f26073f309c79d2a2300c69c](https://stxer.xyz/simulations/mainnet/10434cb1f26073f309c79d2a2300c69c) |
| recovery matrix: none | | [1d4731f2acbb1fee11416c5acd485a93](https://stxer.xyz/simulations/mainnet/1d4731f2acbb1fee11416c5acd485a93) |
| dust-vaults | 68/68 | [a6d2dee0bac0f51f3db61ec978fc30d8](https://stxer.xyz/simulations/mainnet/a6d2dee0bac0f51f3db61ec978fc30d8) |
| vault-fixes L-1 | 50/50 | [32618be4cd9235d21b8fbc8776c2cc29](https://stxer.xyz/simulations/mainnet/32618be4cd9235d21b8fbc8776c2cc29) |
| vault-fixes L-2 + #6 | 45/45 | [bf2943b0bbc5d507a5e416ecc2349d8d](https://stxer.xyz/simulations/mainnet/bf2943b0bbc5d507a5e416ecc2349d8d) |
| vault-fixes #7 | 79/79 | [95a6bae96050d5aa39f969da320c162f](https://stxer.xyz/simulations/mainnet/95a6bae96050d5aa39f969da320c162f) |

SHA-256 of the deployed sources:

| Contract | SHA-256 |
| --- | --- |
| `jing-core-v6` | `88a689affb23f13030953e891336af42a3f5cb275f13b3c54c79d8cd4de50697` |
| `jing-ladder-v1` | `0f1e08b023272ed96a2653f727292626d4b0325dcf4e42963104d977860ec786` |
| `markets-sbtc-stx-jing-v6-3` | `5c08412fc5990a8bf0db3a0cbbec3fa4c859d4185d0caf1cd16ae0c78f851bfb` |
| `swap-router-sbtc-stx-jing-v5-3` | `882374f40bfdf8270b3ea18ba2d7e68fce4431ee17c60f70b00bb2670240fe58` |
| `fastpool-swap-vault` | `1bf8137aec300ae5f700ea3c252629a0ea1f01b642851ad9df053af437ae0a87` |
| `signer-manager-vault-stx-rewards` | `91db429775c07f36308699f5678ab044e51e195b4e3b8f59feffb97f0c10d89c` |

Run the set on one fork: `FORK_BLOCK=<height> node simulations/<sim>`. The matrix is
`pool-vault-stx-stxer.mjs --recovery`, and the fixes are `vault-fixes-stxer.mjs`.
