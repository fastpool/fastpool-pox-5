# Plan: `fastpool-stx-rewards`

A FAST Pool signer manager for pox-5 that pays **all** stacking rewards in
**STX**, by swapping the pool's sBTC on a DEX before distributing.

Status: proposal. Nothing here is implemented yet.

---

## 1. Background

**Stacking in pox-5.** A stacker locks STX against a *signer manager* — a smart
contract implementing pox-5's `signer-manager-trait`. pox-5 calls back into that
contract (`validate-stake!`) to authorize the stacker, and at the end of each
reward cycle it holds the pool's rewards until the signer manager claims them.

**pox-5 pays rewards in sBTC.** Not STX, not L1 bitcoin — sBTC, the SIP-010
token. Whatever a pool wants its stackers to actually receive, the signer
manager is where that conversion happens.

**FAST Pool runs several signer managers, one per reward type.** A stacker picks
their reward by picking which contract they lock against:

| contract | stacker receives |
| --- | --- |
| **`fastpool-stx-rewards`** (this plan) | **STX** |
| `max500` and other siblings | sBTC, L1 BTC, other arrangements |

That is the central design decision, and it is what keeps this contract small:
**there is no per-stacker reward preference to store, freeze, or branch on.**
Everyone locked against `fastpool-stx-rewards` gets STX at the same price. A
stacker who wants something else unstakes and re-stakes against a different
contract.

**Scope.** STX stacking only. Bond stacking is refused at the contract boundary
(§4). No sBTC payouts, no L1 bitcoin withdrawals, no auto-restacking.

---

## 2. How a cycle works

```
  ┌─ 1. claim-rewards(cycle) ──────────────── permissionless
  │      pox-5 → this contract.  sBTC arrives.
  │
  ├─ 2. swap-rewards(cycle, adapter, sats, min-stx-out) ×1..n ── operator only
  │      fee taken in sBTC, remainder swapped for STX on a DEX.
  │
  └─ 3. distribute-rewards[-many](stackers, cycle) ×1..n ─── permissionless
         STX paid out pro-rata.
```

Step 2 is a **separate transaction** from step 3, and the DEX is never called
from inside the payout loop. That keeps an external, untrusted contract out of
the path that moves stackers' money.

### Why swap the whole pot at once

The obvious alternative is to swap each stacker's share as they claim it. It is
worse on every axis:

| | per-stacker swap | pot swap (this plan) |
| --- | --- | --- |
| DEX calls per cycle | one per stacker | one to three |
| price impact | paid N times, worst on the smallest amounts | paid once, on one size |
| DEX pool fee | N × | 1 × |
| splitting a large order across DEXs | impossible | natural |
| price fairness | whoever claims first gets the best fill | everyone gets the same fill |

**The fairness rule, stated plainly:** every stacker in a cycle receives STX at
the same average execution price. Rounding dust from the pro-rata division stays
in the contract.

---

## 3. Why the contract mirrors pox-5's share ledger

pox-5 knows each stacker's share of the pool. Asking it, per stacker, is
prohibitively expensive: pox-5's source is roughly 135 KB, and **every**
`contract-call?` into it is charged that full size as `read_length` regardless of
what the function does. Settling stackers one-by-one through pox-5 therefore
burns essentially the whole block read budget and caps a distribution at a few
hundred stackers per block.

So this contract keeps its own copy of the numbers:

```clarity
(define-map mirrored-shares       { stacker: principal, reward-cycle: uint } uint)
(define-map mirrored-total-shares { reward-cycle: uint } uint)
```

pox-5 calls `validate-stake!` on every path that **increases** a stacker's
shares, which is enough to maintain the mirror. It does **not** call back on
`unstake`. So the mirror can drift — but only ever **upward**, because every
unseen change is a decrease.

That one-sidedness is what makes a single, cheap integrity check sufficient:
compare the contract's `mirrored-total-shares` for a cycle against pox-5's own
signer-level total, `get-signer-pending-staked-ustx-per-cycle`. Since the mirror
can only be too high, **equality proves it is exact.** One pox-5 call, not one
per stacker.

---

## 4. `validate-stake!` — the pox-5 callback

```clarity
(define-public (validate-stake!
  (stacker principal) (first-index uint) (num-indexes uint)
  (amount-ustx uint) (amount-sats uint)
  (is-bond bool) (signer-calldata (optional (buff 500)))) …)
```

- `authorize-pox-5` — reject any caller that is not the pox-5 contract. This
  callback writes per-stacker state keyed by its `stacker` argument; if anyone
  could invoke it directly they could mint themselves shares.
- **`(asserts! (not is-bond) ERR_BONDS_NOT_SUPPORTED)`** — this is how "no bond
  stacking" is enforced. A bond stake against this contract fails cleanly at
  pox-5 rather than silently doing something undefined.
- **`(asserts! (is-none signer-calldata) ERR_CALLDATA_NOT_SUPPORTED)`** — sibling
  signer managers use calldata to register a bitcoin `pox-addr` for L1 payouts.
  This contract has no such path, so a stacker who passes one gets a clear
  failure instead of quietly receiving STX when they expected BTC.
- fold over the `num-indexes` cycles the stake covers (pox-5 caps a lock at 12),
  adding `amount-ustx` into `mirrored-shares` and `mirrored-total-shares`.
- **skip any cycle that already has a `cycle-swap` entry.** Its pot has already
  been priced and divided; late shares must not dilute it. Skip rather than
  fail, so a new stake is never blocked by an old settled cycle. (pox-5 should
  not permit staking into a past cycle in the first place; this is a belt-and-
  braces guard.)

---

## 5. `claim-rewards` — pull the pot in

```clarity
(define-public (claim-rewards (reward-cycle uint)) …)
```

Permissionless. Calls pox-5's `claim-rewards` with an **empty bond-periods
list**, which moves the cycle's sBTC into this contract, then:

- `cycle-rewards[cycle] += earned` — a cycle can be claimed repeatedly as
  rewards accrue, so this accumulates.
- `unswapped-sats += earned` — pot-level sBTC reserve (§9).
- `fee-bips-for-cycle[cycle]` is snapshotted on first claim, so a later fee
  change never applies retroactively to a cycle already in flight.

This contract never calls pox-5's per-stacker settlement
(`claim-staker-rewards-for-signer`). pox-5's internal per-stacker ledger is
therefore left un-zeroed by design; **this contract's mirror is authoritative**
for who is owed what. Because the pox-5 path is not exposed at all, the two can
never be mixed and no double-payout is possible.

---

## 6. DEX adapters

One thin adapter contract per DEX — `dex-adapter-bitflow.clar`,
`dex-adapter-alex.clar`, `dex-adapter-velar.clar` — behind a shared trait:

```clarity
(define-trait dex-adapter-trait (
  ;; (amount-sats, min-stx-out) -> micro-STX delivered to tx-sender
  (swap-sbtc-to-stx (uint uint) (response uint uint))))
```

An adapter holds **no funds and no state**. It exists only to translate one call
shape into another. This contract invokes it inside its own `as-contract?`, so
`tx-sender` is this contract for the whole nested call: the DEX pulls sBTC from
this contract and credits the STX back to it directly, without the adapter ever
touching either asset.

```clarity
(let ((stx-before (stx-get-balance current-contract)))
  (try! (as-contract?
          ((with-ft 'SM3VDXK3….sbtc-token "sbtc-token" net-sats))
          (contract-call? adapter swap-sbtc-to-stx net-sats min-stx-out)))
  (let ((stx-out (- (stx-get-balance current-contract) stx-before)))
    (asserts! (>= stx-out min-stx-out) ERR_SLIPPAGE)
    …))
```

Three independent guards, none of which requires trusting the adapter:

1. **The `as-contract?` allowance is a hard spend cap.** `net-sats` is the most
   sBTC that can leave, whatever the adapter tries.
2. **Credit from the measured balance delta, never the adapter's return value.**
   A buggy or malicious adapter cannot inflate what stackers are owed.
3. **Allowlist.** `(define-map dex-adapters principal bool)`, admin-managed,
   checked with `(contract-of adapter)`. A trait parameter is not authorization.

Keeping adapters in separate contracts is also a cost decision: this contract's
own source is charged as `read_length` on every call into it, so three DEX ABIs
should not be inlined into it.

---

## 7. `swap-rewards` — the operator's call

```clarity
(define-public (swap-rewards
  (reward-cycle uint)
  (adapter <dex-adapter-trait>)
  (amount-sats uint)
  (min-stx-out uint)) …)
```

**Operator only.** Everything else in this contract is permissionless; this one
call is not, and that is deliberate — see §11.

1. `authorize-operator`, and assert `(contract-of adapter)` is allowlisted.
2. `remaining = cycle-rewards[cycle] - cycle-swap[cycle].sats-in`;
   assert `amount-sats <= remaining` → `ERR_SWAP_EXCEEDS_POT`.
3. **Pin the denominator.** Assert
   `mirrored-total-shares[cycle] == pox-5 get-signer-pending-staked-ustx-per-cycle(cycle)`
   → `ERR_SHARE_MIRROR_MISMATCH`. On the first swap leg for a cycle, snapshot
   that value into `cycle-swap[cycle].total-shares`; on later legs, assert it
   still equals the snapshot → `ERR_SHARES_MOVED`.
4. **Fee, in sBTC, before the swap.**
   `fee = amount-sats × fee-bips-for-cycle[cycle] / 10000`,
   `net = amount-sats - fee`, `earned-fees += fee`.
   The fee never touches the DEX, so the pool operator keeps BTC-denominated
   revenue and there is only ever one fee accumulator to withdraw from.
5. Swap `net` through the adapter; measure `stx-out`; assert against
   `min-stx-out`.
6. Book it:
   `unswapped-sats -= amount-sats`, `unpaid-stx += stx-out`,
   `cycle-swap[cycle] = { sats-in: += amount-sats, fee-sats: += fee, stx-out: += stx-out, total-shares: … }`
7. `print` topic `swap-rewards` with the adapter, both amounts, and the implied
   price.

### Two things this shape buys

**Route splitting, for free.** Calling `swap-rewards` three times for the same
cycle with three different adapters and three amounts accumulates into one
`cycle-swap` record. A large pot gets split to cut price impact, and a leg that
reverts on slippage is retried on its own without disturbing the others.

**Immunity to later unstakes.** pox-5 *decrements*
`signer-pending-staked-ustx-per-cycle` when a stacker unstakes, including for a
cycle already rewarded. If distribution checked the mirror against pox-5 live,
a single unstake after the swap would make the check fail and **permanently
block the payout**. Pinning the denominator at swap time avoids that entirely —
and as a bonus, the distribution path then makes **zero pox-5 calls**.

---

## 8. Distribution

```clarity
(define-public (distribute-rewards      (stacker  principal)        (reward-cycle uint)) …)
(define-public (distribute-rewards-many (stackers (list 100 principal)) (reward-cycle uint)) …)
```

Both permissionless — anyone may trigger a payout on a stacker's behalf. Both
compute the same two lines:

```
entitled  = (cycle-swap.stx-out × mirrored-shares[stacker, cycle]) / cycle-swap.total-shares
claimable = entitled - stacker-stx-paid[stacker, cycle]
```

then pay `claimable` with `stx-transfer?` inside `as-contract?` under a
`(with-stx claimable)` allowance, advance the watermark to `entitled`, and
decrement `unpaid-stx`.

`stacker-stx-paid` is a **monotone watermark in STX only**. When more of the pot
is claimed or swapped later, `stx-out` grows, `entitled` grows, and the next
distribution pays exactly the difference. Repeated calls for the same stacker
are safe and idempotent.

### On keeping `-many`

You asked whether to drop `-many` if the accounting gets awkward. It does not,
and the reason is worth stating: the complexity in a mixed-reward signer manager
comes from stackers having *different* output types, which forces a per-stacker
branch and a second watermark in a second asset to keep the two sides from
double-paying. **Neither exists here.** One reward type means one formula, and
`-many` is a plain fold over it. Keep both entry points.

There is no `transfer-many` for STX, so a batch is N `stx-transfer?` calls — but
those are cheap. The cost problem in §3 was pox-5's per-call `read_length`, and
the distribution path no longer calls pox-5 at all. If a 100-stacker batch
proves comfortable in the cost benchmarks, the list bound can be raised.

---

## 9. Balances, reserves and dust

The contract holds two assets. Each gets an explicit liability counter so an
admin sweep can never reach stacker funds.

| asset | held for | liability var | sweepable |
| --- | --- | --- | --- |
| sBTC | accrued fees + pot not yet swapped | `earned-fees`, `unswapped-sats` | `balance − earned-fees − unswapped-sats` |
| STX | swapped proceeds not yet paid out | `unpaid-stx` | `stx-balance − unpaid-stx` |

- `withdraw-fees(amount, recipient)` — admin; sends sBTC, capped at
  `earned-fees`.
- `sweep-sbtc-dust(recipient)` / `sweep-stx-dust(recipient)` — admin; send only
  the sweepable amount above. STX dust is where pro-rata floor-division
  remainders accumulate.

`stx-get-balance` counts locked STX, but this contract never locks STX (stackers
lock their own against it), so the STX figure is clean.

---

## 10. Admin and operator

Two distinct roles.

| role | set by | can do |
| --- | --- | --- |
| **admin** | `update-admin`, seeded to the deployer | set fees, manage the adapter allowlist, withdraw fees, sweep dust, **set the operator** |
| **operator** | `set-operator` (admin-only) | `swap-rewards`, and nothing else |

```clarity
(define-data-var operator principal tx-sender)   ;; deployer at deploy time

(define-public (set-operator (new-operator principal))
  (begin (try! (authorize-admin))
         (print { topic: "set-operator", old: (var-get operator), new: new-operator })
         (ok (var-set operator new-operator))))

(define-private (authorize-operator)
  (ok (asserts! (and (is-eq contract-caller tx-sender)
                     (is-eq tx-sender (var-get operator)))
               ERR_UNAUTHORIZED_OPERATOR)))
```

The operator is a **single mutable principal**, not a set. It is a hot key that
runs a keeper script, so it needs to be rotatable cheaply — one admin call, and
the old key is dead immediately. The `(is-eq contract-caller tx-sender)` clause
means the operator's authority cannot be borrowed by an intermediate contract.

The operator can only choose *when, where and at what price* to swap. It can
never move stacker funds: the `as-contract?` allowance caps the sBTC, the
balance-delta measurement fixes the STX, and distribution is permissionless and
formula-driven.

---

## 11. Security

- **`swap-rewards` must not be permissionless.** With a caller-supplied
  `min-stx-out`, anyone could set it to 1, sandwich the call, and take the pot.
  Gating it on the operator is the whole defence; there is no trustworthy
  on-chain STX/BTC oracle to substitute for it. Claiming and distributing stay
  open to anyone, so a disappeared operator can stall the swap but can never
  strand already-swapped STX.
- **A trait parameter is not authorization** — always check `(contract-of adapter)`
  against the allowlist.
- **Treat the adapter as untrusted** within its `as-contract?` allowance, and
  credit stackers from the measured balance delta rather than its return value.
- **No DEX call inside the distribution loop.**
- **`validate-stake!` is pox-5-only**, and refuses bonds and calldata outright.
- **The denominator is pinned at swap time**, so a post-swap unstake cannot
  block or skew the payout.
- **Shares are frozen after the first swap leg**, so nobody can stake into a
  cycle whose price is already known.

---

## 12. Testing

Neither ALEX nor Bitflow has liquidity in simnet, so the strategy is split:

- **`contracts/mock-dex-adapter.clar`** — admin-settable fixed rate, pre-funded
  with STX, with injectable failure modes: under-delivers against
  `min-stx-out`, delivers nothing, reverts. This drives every unit test.
- **Mainnet-fork tests** are the only way to validate the real adapters' call
  shapes. Pull each DEX in through Clarinet `requirements`, as the sBTC suite
  already is. Budget for this: a transposed argument in an ALEX `swap-helper`
  call is not catchable against a mock.

Cases that must be covered:

- pro-rata split across several stackers; sum of payouts + dust == `stx-out`
- partial swap → distribute → second `claim-rewards` → second swap → distribute
  again pays exactly the increment
- repeated `distribute-rewards` for the same stacker is a no-op
- **unstake after the swap** — distribution still succeeds and is unaffected
- mirror mismatch at swap time → `ERR_SHARE_MIRROR_MISMATCH`
- shares moved between two swap legs → `ERR_SHARES_MOVED`
- bond stake and calldata stake both rejected in `validate-stake!`
- non-allowlisted adapter rejected; non-operator caller rejected
- adapter under-delivering → whole transaction reverts, no state moved
- fee is exactly `fee-bips` of the pot, in sBTC, and withdrawable
- neither sweep can touch `unswapped-sats`, `earned-fees` or `unpaid-stx`
- operator rotation: old operator immediately loses `swap-rewards`
- cost benchmark for a 100-stacker `distribute-rewards-many`

---

## 13. Off-chain keeper

`scripts/swap-and-distribute.mjs`, run once per cycle:

1. `claim-rewards(cycle)`
2. read `get-swap-status(cycle)` → sats remaining to swap
3. quote every allowlisted adapter (Bitflow, ALEX, Velar) for the full size and
   for candidate splits
4. choose the split minimising total price impact;
   `min-out = quote × (1 − slippage-bips)`
5. broadcast one `swap-rewards` per leg, with post-conditions — sBTC out
   `<= amount-sats`, STX in `>= min-stx-out`
6. re-read `get-swap-status`; only once the pot is fully swapped, page through
   `distribute-rewards-many`

`bootstrap.mjs` subcommands to add: `swap`, `swap-status`, `set-operator`,
`distribute`.

---

## 14. Contract surface

```clarity
;; pox-5 callback
validate-stake!            (stacker, first-index, num-indexes, amount-ustx,
                            amount-sats, is-bond, signer-calldata)  ;; pox-5 only

;; cycle lifecycle
claim-rewards              (reward-cycle)                           ;; anyone
swap-rewards               (reward-cycle, adapter, amount-sats, min-stx-out)  ;; operator
distribute-rewards         (stacker, reward-cycle)                  ;; anyone
distribute-rewards-many    (stackers, reward-cycle)                 ;; anyone

;; admin
update-admin               (admin, enabled)
set-operator               (new-operator)
update-fees                (new-fees-bips)
set-dex-adapter            (adapter, enabled)
withdraw-fees              (amount, recipient)
sweep-sbtc-dust            (recipient)
sweep-stx-dust             (recipient)
register-self              (signer-manager, signer-key, auth-id, signer-sig)

;; read-only
get-stacker-rewards        (stacker, reward-cycle) -> { entitled, paid, claimable }
get-swap-status            (reward-cycle) -> { pot-sats, swapped-sats, remaining-sats,
                                               stx-out, total-shares }
get-mirrored-shares        (stacker, reward-cycle)
get-mirrored-total-shares  (reward-cycle)
check-mirror               (reward-cycle) -> { local, pox-5, matches }
get-fee-bips-for-cycle     (reward-cycle)
get-operator               ()
is-admin                   (caller)
is-dex-adapter             (adapter)
get-earned-fees            ()
get-unswapped-sats         ()
get-unpaid-stx             ()
```

### Error codes

```
u1001 ERR_UNAUTHORIZED_ADMIN          u1007 ERR_SLIPPAGE
u1002 ERR_UNAUTHORIZED_OPERATOR       u1008 ERR_SHARE_MIRROR_MISMATCH
u1003 ERR_UNAUTHORIZED_CALLER         u1009 ERR_SHARES_MOVED
u1004 ERR_INVALID_FEES_BIPS           u1010 ERR_SWAP_EXCEEDS_POT
u1005 ERR_INSUFFICIENT_FEES           u1011 ERR_NOTHING_TO_DISTRIBUTE
u1006 ERR_ADAPTER_NOT_ALLOWED         u1012 ERR_NO_DUST
u1013 ERR_BONDS_NOT_SUPPORTED         u1014 ERR_CALLDATA_NOT_SUPPORTED
```

---

## 15. Phasing

| phase | content | shippable alone |
| --- | --- | --- |
| 1 | `validate-stake!`, the share mirror, `claim-rewards`, admin/operator roles, read-onlys, tests — **no DEX yet** | yes |
| 2 | adapter trait, allowlist, mock adapter, `swap-rewards` | yes |
| 3 | `distribute-rewards` / `-many`, reserves, sweeps | yes |
| 4 | real adapters (Bitflow, ALEX, Velar) + mainnet-fork tests | per-DEX |
| 5 | keeper script and `bootstrap.mjs` subcommands | yes |

Phase 1 is worth landing on its own: it is pure accounting, fully testable
without a DEX, and it is where the subtle correctness lives.

---

## 16. Open decisions

1. **Which DEXs at launch.** Bitflow and ALEX both have real sBTC/STX depth;
   Velar is a third. Each is one adapter plus one fork test.
2. **Batch size.** Start at 100 stackers per `distribute-rewards-many` and raise
   it once the phase-3 cost benchmark says what fits in a block.
3. **Slippage policy.** How wide a `min-stx-out` tolerance the keeper uses, and
   whether to add an on-chain ceiling on it as a second line of defence against
   a compromised operator key.
4. **Operator liveness.** If the operator never swaps a cycle, the sBTC simply
   sits in the contract. Worth deciding whether an admin fallback path (or a
   timeout after which anyone may swap at a conservative floor price) is needed,
   or whether admin-rotates-the-operator is a sufficient answer.
