# Two-phase pool vault stxer simulations

> Current 2026-09-23 v6-3 recovery and regression results: [cancel-only recovery verification](README-v6-3-recovery.md). The notes below describe the earlier verification; linked JSON artifacts now contain the current reruns.

Run from either repository root:

```sh
node simulations/pool-vault-stx-stxer.mjs
node simulations/pool-vault-stx-stxer.mjs --maker
node simulations/pool-vault-stx-stxer.mjs --lifecycle
```

The default checks exact-source deployment, authorization, empty/pending states and phase gates.
`--maker` sells a funded reward batch on the real Jing book during patience.
`--lifecycle` rests, advances 288 burn blocks, reclaims, sells through the real smart router
in two chunks, checks the one-block cooldown, finalizes and distributes native STX.
Both funded cases check exact 1:3 payouts and payout replay safety.

Current FastPool results pass **82/82 checks**:

- deployment and guards: **15/15**
- real Jing maker-fill lifecycle: **32/32**
- real router liquidation lifecycle: **35/35**

The FastPool runner deploys `signer-manager-vault-stx-rewards` under its production name,
passes `.fastpool-swap-vault` through `juice-swap-vault-trait-v2` (fork-deployed before the vault and pool), and checks the
`close-batch` / `ready-to-finish` transition before maker proceeds are finalized.

Juice's entry point lives in `stacking-juice/stx-juice/simulations`; FastPool's is here.
The shared runner is `_pool-vault-stxer.mjs` in this repo. It uses this repo's installed
`stxer` and Stacks dependencies if available, otherwise the installed Juice dependencies.
The signed oracle-update helper lives in sibling `jing-contracts-v3/simulations/_lazer.js`.
It automatically uses the public backend when `PYTH_API_KEY` is absent.
Set `STACKS_API_URL` or `STXER_API_URL` to override the API endpoints.

Each runner writes machine-checked reports to `simulations/results/pool-vault-stx` in its own repo;
the README there links to the successful fork runs and describes the fixtures.
Pool/vault production source is unchanged. Funded tests seed accrued PoX rewards and shares
in fork storage; they do not test creating new STX locks or signer registration.
The router case compresses synthetic Bitcoin intervals to one second, keeping all production
signature and 80-second freshness checks enabled. The simulated two-day interval therefore
tests burn-height gates and cooldown, rather than real elapsed wall time or days of market changes.

All token transfers, order cancellations and storage fixtures affect the stxer fork only.
No mainnet transactions are broadcast, and no private keys are required.
