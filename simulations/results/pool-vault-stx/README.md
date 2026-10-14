# Fastpool swap-vault fork results

All production pool and vault sources were deployed unchanged, using Clarity 6.
The forks use the real PoX-5 claim path, sBTC ledger, Jing v6 market, smart router and AMM state.
Signed BTC/STX Lazer updates came from the public Jing backend; no private Pyth key was needed.

| Case | Passed | Simulation | Raw results |
| --- | --- | --- | --- |
| deployment-guards | 34/34 | [stxer](https://stxer.xyz/simulations/mainnet/4cd9e4be9cc725ab1c20ca159d50f0e0) | [fastpool-deployment-guards.json](fastpool-deployment-guards.json) |
| maker | 36/36 | [stxer](https://stxer.xyz/simulations/mainnet/427ba446a62bf6bb018c04b67afafb02) | [fastpool-maker.json](fastpool-maker.json) |
| liquidation | 42/42 | [stxer](https://stxer.xyz/simulations/mainnet/b2f4c5632f77a55153e194209d7bad09) | [fastpool-liquidation.json](fastpool-liquidation.json) |

The current trait-based FastPool contracts pass **112/112 checks** across these three forks (2026-10-13 rerun on trait v2 with the Pyth fee budget).
The guard fork verifies exact-source Clarity 6 deployment, the shared vault trait v2 (fork-deployed first),
active-vault arguments, authorization, and empty-state guards, and the Pyth fee budget setter
(direct-call refusal, pool admin wrapper, active-vault check, 10 STX bound, `get-config`). The maker lifecycle explicitly
closes the externally filled batch before finalization and verifies `ready-to-finish`.

The lifecycle cases seed crystallized PoX rewards and 1:3 shares with fork-only `Eval` writes,
then exercise pool claiming, vault conversion, return, pro-rata native STX payouts and replay protection.
They do not exercise signer registration, STX lock admission, or reward calculation from new stakes.
The router case uses one-second synthetic Bitcoin blocks to advance the full 288-block
patience window and the one-block cooldown while retaining a real signed update.
The production 80-second freshness checks remain enabled. The maker case needs no block advance.
Existing Jing makers were canceled only inside each fork; the maker case adds real-token depth
behind the vault to satisfy the market's full-fill taker requirement.
These are independent fork snapshots, with zero pool fees in the stxer lifecycle cases;
fee and OG behavior is covered by the separate simnet tests.
