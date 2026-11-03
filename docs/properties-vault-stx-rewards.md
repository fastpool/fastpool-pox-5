# Properties of `signer-manager-vault-stx-rewards`

The STX-rewards signer manager that delegates the sBTC -> STX conversion to an
upgradeable swap vault (`fastpool-swap-vault`, PR #1). It is built on
`fastpool-stx-rewards-signer-manager` (main), from which it keeps the share
mirror, pinning, fee schedule (5% cap, delayed increases), payout watermarks and
sweeps unchanged. See [properties-stx-rewards.md](properties-stx-rewards.md) for
those. This file covers what the vault adds.

| tag | harness |
| --- | --- |
| **RV-I** | Rendezvous invariant (`pnpm test:rv:vault`), re-checked after every call in a random sequence |
| **RV-P** | Rendezvous property (`pnpm test:rv:vault:prop`), fuzzed inputs |
| **UNIT** | `tests/vault-stx-rewards.test.ts`, driven through pox-5 and `mock-swap-vault` |

## Cycle lifecycle

1. `claim-rewards`: pox-5 -> here, opens a 432-block funding window.
2. `pin-shares`: freeze the denominator.
3. `fund-swap-vault`: the cycle's unfunded pot, net of fees, to the active vault.
4. `finalize-swap-vault` (sold out) or `recover-swap-vault` (after the vault's
   own recovery delay): book what came back.
5. `release-unfunded`: after the window, release whatever was never funded as
   sBTC. Run implicitly by `distribute-*`.
6. `distribute-*`: pay the STX and sBTC legs pro-rata.

Every step is permissionless.

## Properties

| # | property | enforced by | checked by |
| --- | --- | --- | --- |
| V1 | No sBTC can be stranded by a missing or broken vault. sBTC never funded is released as sBTC once the window closes. | `release-unfunded` | RV-I, RV-P, UNIT |
| V2 | sBTC a vault could not sell comes back through `recover-swap-vault`. Anyone can call it, and only the vault's own delay gates it. | no auth on `recover-swap-vault` | RV-I, UNIT |
| V3 | What comes back from a vault is credited from this contract's balance deltas, never from the vault's reported figures. | `settle-batch` | RV-I (mutant), RV-P, UNIT |
| V4 | Funding sends exactly `gross - fee` and checks the vault took exactly that. | `ERR_VAULT_FUNDING_MISMATCH` | RV-P, UNIT |
| V5 | Fees are charged once per sat: on funding or on release, never both, and never on recovered sBTC. | fee only in `fund-swap-vault` / `release-unfunded` | RV-I (fee <= cap on funded + released), RV-P, UNIT |
| V6 | One batch per vault at a time; a cycle's `in-vault-sats` is exactly the sum of the batches held for it. | `vault-batches` map | RV-I, RV-P, UNIT |
| V7 | Only a vault this contract funded can be finalized or recovered, which is what authorizes the trait argument. | `ERR_NO_VAULT_BATCH` | RV-P, UNIT |
| V8 | A new vault must be bound to this contract (`pool`), idle, and not the active vault. It takes effect only after `SWAP_VAULT_COOLDOWN` (4032 burn blocks), and the checks run again at confirm. | `assert-idle-vault`, `confirm-swap-vault` | UNIT |
| V9 | The outgoing vault is not consulted on rotation, so a broken vault can always be replaced. Its batch stays finalizable, recoverable and tradeable. | `vault-batches` keyed by vault | UNIT |
| V10 | Vault price settings are bounded tighter than the vault's own: slippage <= 3%, leeway <= 5%, no-Pyth slippage <= 10%, DIA band 0.01%..10%. A band of 0 would switch off the Pyth/DIA cross-check, so it is refused. | `MAX_VAULT_*` | RV-P, UNIT |
| V11 | Only the operator can trigger trades, and only on the active vault or one still holding a batch. Only admins configure or rotate. | `authorize-operator`, `authorize-admin` | RV-P, UNIT |
| V12 | Solvency: `unpaid-stx <= STX balance` and `earned-fees + unswapped-sats <= sBTC balance`, so sweeps can never reach staker funds. | liability counters | RV-I (mutant), RV-P, UNIT |
| V13 | No staker is ever paid more than their current entitlement on either leg. | monotone watermarks | RV-I |

## Known limits (vault-side, not fixable here)

- `finish` keeps up to `pyth-fee-budget` (<= 10 STX) back for the next batch's
  oracle fees, and `emergency-recover` returns the whole STX balance. That
  reserve therefore moves from one cycle's proceeds to a later cycle's.
- When DIA errors, the vault's `get-no-pyth-price` falls back to the Jing RFQ
  native price **halved**, and `router-swap-split-dia` sells against that. The
  signer manager's caps do not reach this path; it should be bounded in the
  vault.

## Rendezvous harness

The harness lives in the contract under `#[env(simnet)]` and is stripped from
every other network. pox-5 cannot produce a reward pot inside a random call
sequence, so `rv-seed-cycle` / `rv-seed-and-fund` create claimed, pinned cycles
with a real sBTC pot. Their IDs start at `RV_CYCLE_BASE`, clear of any cycle
pox-5 could claim. `rv-fund`, `rv-release` and `rv-distribute[-many]` route a
random number onto a seeded cycle and call the real entry points. `rv-vault-*`
drives the mock vault: sales, injected misbehaviour, the kept-back reserve.
`rv-donate-*` sends stray funds. `rv-adopt-vault` switches vaults using the
production idle checks but skips the notice period; the real propose/confirm
path is fuzzed alongside it.

Harness sanity: two deliberately broken builds both fail the invariant suite
(seed 7, 1000 runs). Crediting the reported STX breaks
`invariant-stx-liability-is-covered`. Keeping the fee inside the staker
liability on release breaks `invariant-sbtc-liability-is-covered`.
