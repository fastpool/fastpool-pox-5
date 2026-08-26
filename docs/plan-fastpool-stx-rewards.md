# Plan: `fastpool-stx-rewards`

A FAST Pool signer manager for pox-5 that pays stacking rewards in **STX**, by
swapping the pool's sBTC on a DEX before distributing.

Status: **phases 1-3 implemented.** `contracts/stx-rewards.clar` (deployed as
`fastpool-stx-rewards`), `contracts/dex-traits.clar`, and the two test support
contracts are in the tree and passing; `clarinet check` reports 0 errors and
`tests/stx-rewards.test.ts` is green. Phases 4-6 -- the real DEX adapters, the
keeper script, and the miner-commit oracle -- are still proposals. See §17.

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
(§4). No L1 bitcoin withdrawals, no auto-restacking. sBTC leaves this contract
only as fee withdrawals and as the timeout fallback in §10.

---

## 2. How a cycle works

```
  ┌─ 1. claim-rewards(cycle) ─────────────────────────── permissionless
  │      pox-5 → this contract. sBTC arrives.
  │      Starts a 3-day swap window (SWAP_WINDOW_BURN_BLOCKS).
  │
  ├─ 2. pin-shares(cycle) ────────────────────────────── permissionless
  │      Freeze the pro-rata denominator against pox-5.
  │
  ├─ 3. swap-rewards(cycle, adapter, sats, min-stx-out) ×1..n ─ operator only
  │      Only while the window is open. Fee taken in sBTC,
  │      remainder swapped for STX on a DEX.
  │
  └─ 4. distribute-rewards[-many](stackers, cycle) ×1..n ─ permissionless
         STX paid pro-rata. Anything left unswapped when the
         window closed is paid as sBTC instead.
```

Step 3 is a **separate transaction** from step 4, and the DEX is never called
from inside the payout loop. That keeps an external, untrusted contract out of
the path that moves stackers' money.

### Why swap the whole pot at once

The obvious alternative is to swap each stacker's share as they claim it. It is
worse on every axis:

| | per-stacker swap | pot swap (this plan) |
| --- | --- | --- |
| DEX calls per cycle | one per stacker | one to four |
| price impact | paid N times, worst on the smallest amounts | paid once, on one size |
| DEX pool fee | N × | 1 × |
| splitting a large order across venues | impossible | natural |
| price fairness | whoever claims first gets the best fill | everyone gets the same fill |

**The fairness rule, stated plainly:** every stacker in a cycle receives STX at
the same average execution price. Rounding dust from the pro-rata division stays
in the contract.

---

## 3. The share mirror

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
compare this contract's `mirrored-total-shares` for a cycle against pox-5's own
signer-level total, `get-signer-pending-staked-ustx-per-cycle`. Since the mirror
can only be too high, **equality proves it is exact.** One pox-5 call, not one
per stacker.

### When the mirror actually drifts

pox-5's `unstake` removes the stacker from cycles starting at
`current-cycle + 1` only — it never touches the current or any past cycle. So:

- Once a cycle has **ended**, pox-5's numbers for it are frozen. Nothing can
  move them afterwards.
- But a stacker who locked for cycles 10–15 and unstaked during cycle 12 was
  removed from 13, 14 and 15 *while those were still future*. This contract
  never saw that. So when cycle 13 later ends and is claimed, **the mirror for
  cycle 13 is high and the equality check will fail.**

This is a normal, expected event, not a bug — so it must have a cheap,
permissionless repair rather than blocking anything.

```clarity
(define-public (repair-mirror-many (stackers (list 300 principal)) (reward-cycle uint)) …)
```

For each listed stacker it reads pox-5's authoritative
`get-staker-shares-staked-for-cycle` and writes that value into
`mirrored-shares`, adjusting `mirrored-total-shares` by the difference. It costs
one pox-5 call for the batch. It refuses a cycle whose shares are already pinned
(§6). Off-chain, the keeper knows exactly which stackers to pass: it holds the
pool's stacker list and can diff the mirror against pox-5 with read-only calls.

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
- **skip any cycle whose shares are already pinned.** Its pot has already been
  priced and divided; late shares must not dilute it. Skip rather than fail, so
  a new stake is never blocked by an old settled cycle. (pox-5 should not permit
  staking into a past cycle in the first place; this is a belt-and-braces guard.)

---

## 5. `claim-rewards` — pull the pot in and start the clock

```clarity
(define-public (claim-rewards (reward-cycle uint)) …)
```

Permissionless. Calls pox-5's `claim-rewards` with an **empty bond-periods
list**, which moves the cycle's sBTC into this contract, then:

- `pot-sats[cycle] += earned` — a cycle can be claimed repeatedly as rewards
  accrue, so this accumulates.
- `unswapped-sats += earned` — the contract-level sBTC reserve (§11).
- On the **first** claim for the cycle only:
  - `fee-bips-for-cycle[cycle] = fees-bips`, so a later fee change never applies
    retroactively to a cycle already in flight.
  - `swap-deadline[cycle] = burn-block-height + SWAP_WINDOW_BURN_BLOCKS`.

```clarity
;; ~3 days at one bitcoin block per 10 minutes. Actual wall-clock drifts with
;; real block times; the contract only ever reasons in burn blocks.
(define-constant SWAP_WINDOW_BURN_BLOCKS u432)
```

There is deliberately **no mirror check here**, so a drifted mirror (§3) can
never block the pot from being pulled out of pox-5. The check happens at
`pin-shares`, which is retryable after a repair.

This contract never calls pox-5's per-stacker settlement
(`claim-staker-rewards-for-signer`). pox-5's internal per-stacker ledger is
therefore left un-zeroed by design; **this contract's mirror is authoritative**
for who is owed what. Because the pox-5 path is not exposed at all, the two can
never be mixed and no double-payout is possible.

---

## 6. `pin-shares` — freeze the denominator

```clarity
(define-public (pin-shares (reward-cycle uint)) …)
```

Permissionless. Asserts
`mirrored-total-shares[cycle] == pox-5 get-signer-pending-staked-ustx-per-cycle(cycle)`
→ `ERR_SHARE_MIRROR_MISMATCH`, then writes that value into
`cycle-settlement[cycle].total-shares` and marks the cycle pinned.

Required before the first `swap-rewards` and before the first distribution. Both
call it implicitly if it has not run yet, so it is rarely a separate transaction
in practice — but having it as its own entry point means a mirror mismatch
surfaces as an isolated, obviously-diagnosable failure instead of a confusing
revert inside a swap.

Pinning is what makes every later step cheap and stable:

- the **distribution path makes zero pox-5 calls**;
- multiple swap legs all divide by the same denominator;
- `validate-stake!` and `repair-mirror-many` both stop touching the cycle, so
  nothing can move under a pot that has already been priced.

If pinning fails, the fix is mechanical: `repair-mirror-many` the affected
stackers, then pin again. Nothing is lost and no deadline is at risk — the
timeout in §9 is measured from the claim, and pinning is a matter of minutes.

---

## 7. DEX adapters

**Two built, two blocked.** The launch list was Bitflow DLMM, Bitflow standard,
ALEX and Velar. Checking each against mainnet before writing any code changed
that:

| adapter | venue | status |
| --- | --- | --- |
| `dex-adapter-bitflow-dlmm` | Bitflow DLMM | **built** — `dlmm-swap-router-v-1-2` + `dlmm-pool-stx-sbtc-v-2-bps-15` |
| `dex-adapter-bitflow-xyk` | Bitflow standard | **built** — `xyk-swap-helper-v-1-3` + `xyk-pool-sbtc-stx-v-1-1` |
| ALEX | — | **blocked: no sBTC/STX pool exists** |
| Velar | — | **blocked: router contract not identifiable** |
| Jing RFQ | `rfq-sbtc-stx-jing-v2-3` | **impossible as an adapter** — see below. Used as the price oracle instead. |

**ALEX has no sBTC pool at all.** All 60 of its pools trade *wrapped* tokens —
`token-wstx`, `token-abtc`, `token-wbtc`, `token-waewbtc`. Reaching STX from
sBTC there would mean a multi-hop through a bridged BTC, which is a different
asset with different counterparty risk. That is a product decision, not an
implementation detail, so no adapter was written.

**Velar could not be pinned down.** Bitflow's own router reports a
`VELAR_UNIV2V2_PATH` route for sBTC→STX, so the pool exists, but the router's
contract principal did not surface in chain data. The adapter is ~30 lines once
someone confirms the principal and ABI.

### Jing's RFQ cannot be wrapped as an adapter

`SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.rfq-sbtc-stx-jing-v2-3` is a
request-for-quote venue, not an AMM, and two independent properties of it rule
out an adapter. Either one alone would be fatal.

**1. It is not atomic.** `open-rfq(sbtc-in, min-stx-out, x, x-name)` escrows the
sBTC and returns an id. Nothing comes back in that transaction. A market maker
later calls `fix-price`, then `fulfill`, and only then does STX move. The
adapter trait in section 6 promises an atomic swap, and the signer manager
measures its STX balance immediately afterwards — it would see zero and revert
on `ERR_SLIPPAGE`, rolling back the escrow. Safe, but useless.

**2. A contract can never be an RFQ client.** `fix-price` authenticates the
quote like this:

```clarity
(asserts! (is-eq
  (unwrap! (principal-of? (unwrap! (secp256k1-recover? (build-auth-hash ...) sig) ...)) ...)
  client) ERR_BAD_AUTH)
```

The signature must recover to the **client** — whoever called `open-rfq`. If the
signer manager opens the RFQ inside `as-contract?`, `client` is the manager's
*contract* principal. `principal-of?` only ever yields a standard principal, so
that equality can never hold. A contract has no private key and cannot sign, so
every RFQ it opened would sit unfilled until `reclaim`.

For completeness, `fulfill` is also called by the market maker and pays out of
the MM's own STX balance (`stx-transfer? client-receives mm client`), so the
manager could not drive settlement even if it could be fixed.

Supporting this venue would need Jing to accept contract-principal
authorization in place of signature authorization. That is a change on their
side, not something a wrapper can paper over. Routing around it by handing the
operator custody of the sBTC is not an option — the whole point of the
`as-contract?` allowances and the balance-delta accounting is that the operator
never touches stacker funds.

Bitflow DLMM and Bitflow standard are separate adapters despite sharing a venue:
different call shapes and, more importantly, **different price-impact curves**.
Splitting an order across the two is often better than routing all of it to
whichever quotes best at zero size — which is exactly what the multi-leg design
in §9 is for.

### Native STX, confirmed

Both routers denominate STX as `SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2`.
That is a SIP-010 **facade over native STX**, not a wrapped balance: real swap
transactions on these pools emit `stx_asset transfer` events, not FT transfers.
This was worth checking before anything else — had it been a wrapped token, the
signer manager's native `stx-get-balance` delta would have measured zero and
every swap would have reverted on `ERR_SLIPPAGE`. It is not, so §6's
balance-delta accounting is sound as written.

### Liquidity is thin, and that shapes operations

Measured against the live XYK pool with its own on-chain quote:

| leg size | µSTX per sat | vs near-spot |
| --- | --- | --- |
| 0.001 sBTC | 2883 | — |
| 0.010 sBTC | 2830 | −1.8% |
| 0.050 sBTC | 2615 | −9.3% |
| 0.100 sBTC | 2389 | −17% |
| 0.400 sBTC | 1572 | **−45%** |

A whole pot through one venue in one transaction would be a catastrophe. This is
the strongest argument for the multi-leg design in §9 and for a **three-day**
window rather than a three-block one: legs can be spread across venues *and*
across time. Operator guidance lives in
[deploy-stx-rewards.md](deploy-stx-rewards.md) §7.

Note the interaction with §8: a leg big enough to move the pool past
`max-slippage-bips` is refused by the baseline floor. That is the floor working
as intended — an implicit cap on leg size relative to pool depth.

All four sit behind one trait:

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
own source is charged as `read_length` on every call into it, so four DEX ABIs
should not be inlined into it.

---

## 8. The price baseline

`min-stx-out` is chosen by the operator. On its own that is a hot key that can
set it to 1 and accept any fill. So the contract holds a **baseline price** and
can refuse a `min-stx-out` more than `max-slippage-bips` below it.

**That refusal is switched OFF at launch.** The baseline is recorded on every
swap and enforced on none of them -- see "Informational first" below.

```clarity
(define-trait price-oracle-trait (
  ;; sats -> micro-STX at the baseline price
  (sats-to-ustx (uint) (response uint uint))))
```

The oracle is **pinned to one admin-set principal**, not an allowlist — the
operator must not be able to pick a favourable oracle. Clarity cannot invoke a
stored principal directly, so the call takes a trait parameter and the contract
asserts `(is-eq (contract-of oracle) (var-get price-oracle))`.

### Two implementations

`contracts/price-oracle-dummy.clar` — an admin-settable rate. Used in tests and
on testnet, where the mainnet feed below does not exist.

`contracts/price-oracle-jing.clar` — **the production oracle**, and it is the
miner-commit baseline this section originally proposed building. It wraps
`get-native-price` on Jing's RFQ contract, which already computes exactly that.

**Correction to an earlier version of this plan:** it claimed miner commitments
were not readable from Clarity and that the oracle would have to be fed from off
chain. That is wrong. Clarity exposes `get-tenure-info? miner-spend-total`, and
Jing samples it directly over recent tenures:

```
price = 100 * coinbase-ustx * PRICE_PRECISION / avg(miner-spend-total)
```

Nothing off-chain is involved. `contracts/price-oracle-jing.clar` converts that
to the trait's `sats -> micro-STX` using Jing's own scaling
(`sats * price / 1e10`), so the floor is denominated the same way Jing
denominates its own price band.

It also confirms the coinbase: `get-coinbase-ustx` reads **1000 STX**.

### What the baseline actually measures

Miners commit BTC to win a tenure and are paid the STX coinbase. The ratio of
the two is a native, on-chain, expensive-to-manipulate estimate of STX priced in
BTC — the "miner commit price". In PoX those commitments are precisely what
flows to stackers, so this contract can reconstruct the network-wide figure from
numbers it and pox-5 already hold:

```
sats_to_all_stackers(cycle) = pot-sats[cycle]
                              × pox-5 get-total-shares-staked-for-cycle(cycle)
                              / cycle-settlement[cycle].total-shares

ustx_minted(cycle)          = pox-5 reward-cycle-length      ;; burn blocks in the cycle
                              × COINBASE_USTX                ;; 1000 STX per tenure, fixed

baseline                    = sats_to_all_stackers / ustx_minted    ;; sats per uSTX
```

**It measures miner willingness-to-pay, not spot**, and on mainnet today it runs
*above* the market. Measured at the same moment:

| source | µSTX/sat |
| --- | --- |
| miner-commit baseline (`get-native-price`) | 3632 |
| Bitflow XYK near-spot | 2883 |

That is a **20.6% gap**, with the baseline high.

**This is a calibration trap, and it is why `max-slippage-bips` matters.** The
default of `u2000` (20%) would reject a swap filling at true spot, because true
spot is already ~21% under the baseline. Set the tolerance wide enough to clear
the gap with room to spare, and re-check it — the gap moves with the market.
Guidance in [deploy-stx-rewards.md](deploy-stx-rewards.md) section 6.

So this remains a **sanity floor, not a pricing feed**: it catches a
catastrophic or malicious `min-stx-out` and nothing finer. The tight bound on
execution quality is the keeper's own fresh DEX quote, which sets `min-stx-out`
far above this floor in normal operation.

If `get-native-price` has no usable tenure samples it returns an error, which
propagates and fails `swap-rewards` closed. That is the right direction to fail,
but a chain state with no samples stalls swapping until the window expires and
the pot pays out as sBTC.

---

## 9. `swap-rewards` — the operator's call

```clarity
(define-public (swap-rewards
  (reward-cycle uint)
  (adapter <dex-adapter-trait>)
  (oracle <price-oracle-trait>)
  (amount-sats uint)
  (min-stx-out uint)) …)
```

**Operator only.** Everything else in this contract is permissionless; this one
call is not, and that is deliberate — see §13.

1. `authorize-operator`; assert `(contract-of adapter)` is allowlisted; assert
   `(contract-of oracle)` is the pinned oracle.
2. **Window.** `(asserts! (<= burn-block-height (get deadline …)) ERR_SWAP_WINDOW_CLOSED)`.
3. Ensure shares are pinned (§6).
4. `remaining = pot-sats[cycle] - swapped-sats[cycle]`;
   assert `amount-sats <= remaining` → `ERR_SWAP_EXCEEDS_POT`.
5. **Fee, in sBTC, before the swap.**
   `fee = amount-sats × fee-bips-for-cycle[cycle] / 10000`,
   `net = amount-sats - fee`, `earned-fees += fee`.
   The fee never touches the DEX, so the pool keeps BTC-denominated revenue and
   there is only ever one fee accumulator to withdraw from.
6. **Baseline floor.**
   `(asserts! (>= min-stx-out (/ (* (try! (contract-call? oracle sats-to-ustx net))
                                    (- MAX_BIPS (var-get max-slippage-bips)))
                                 MAX_BIPS))
             ERR_MIN_OUT_TOO_LOW)`
7. Swap `net` through the adapter; measure `stx-out`; assert against
   `min-stx-out`.
8. Book it: `unswapped-sats -= amount-sats`, `unpaid-stx += stx-out`,
   `swapped-sats[cycle] += amount-sats`, `fee-sats[cycle] += fee`,
   `stx-out[cycle] += stx-out`.
9. `print` topic `swap-rewards` with the adapter, both amounts, and the implied
   price.

### Route splitting falls out of this

Calling `swap-rewards` four times for the same cycle — DLMM, Bitflow standard,
ALEX, Velar — with four amounts accumulates into one settlement record. A large
pot gets split to cut price impact, and a leg that reverts on slippage is
retried on its own without disturbing the others.

### The window is a liveness backstop, not a schedule

In normal operation the keeper swaps within minutes of the claim and the
deadline is never approached. It exists so that a lost operator key, a stalled
keeper, or a chain-wide DEX outage cannot strand a cycle's rewards indefinitely.
When it expires, the unswapped remainder becomes sBTC-payable (§10) and nobody
has to wait on an admin.

---

## 10. Distribution

```clarity
(define-public (distribute-rewards      (stacker  principal)             (reward-cycle uint)) …)
(define-public (distribute-rewards-many (stackers (list 300 principal))  (reward-cycle uint)) …)
```

Both permissionless — anyone may trigger a payout on a stacker's behalf. Both
compute the same two legs per stacker, with `D = cycle-settlement.total-shares`
and `shares = mirrored-shares[stacker, cycle]`:

```
;; STX leg — available as soon as anything has been swapped
stx-entitled   = stx-out × shares / D
stx-due        = stx-entitled - stacker-stx-paid

;; sBTC leg — zero until the swap window has closed
unswapped      = pot-sats - swapped-sats                  (0 while window open)
sbtc-entitled  = unswapped × shares / D                   (gross)
sbtc-gross-due = sbtc-entitled - stacker-sbtc-accounted
sbtc-fee       = sbtc-gross-due × fee-bips-for-cycle / 10000
sbtc-due       = sbtc-gross-due - sbtc-fee
```

**There is no branch.** Every stacker gets both legs; one of them is almost
always zero. Fully-swapped cycle → `sbtc-due = 0`. Timed-out cycle → `stx-due =
0`. Partially swapped then timed out → both non-zero, and the split is the same
proportion for everyone.

STX is paid with `stx-transfer?` inside `as-contract?` under a `(with-stx …)`
allowance, one call per stacker — there is no `transfer-many` for STX, but these
are cheap. sBTC is accumulated into a list and paid with a **single
`transfer-many`** at the end of the batch.

Both watermarks are **monotone**: `stacker-stx-paid` in micro-STX,
`stacker-sbtc-accounted` in gross sats. When more of the pot is claimed or
swapped later, the entitlements grow and the next call pays exactly the
difference. Repeated calls for the same stacker are safe and idempotent.

**Fees are always sBTC.** On the swapped portion the fee was taken at swap time;
on the fallback portion it is taken here. Both land in the same `earned-fees`
accumulator.

### On keeping `-many`

The complexity in a mixed-reward signer manager comes from stackers having
*different* output types, which forces a per-stacker branch. That does not exist
here: the two legs above are per-cycle proportions applied uniformly, so `-many`
is a plain fold over one pair of formulas. Keep both entry points.

**Batch size 300, measured.** The distribution path makes zero pox-5 calls, so
the old `read_length` ceiling is gone. `tests/bench-distribute-many.test.ts`
runs a real 300-stacker batch on both legs — 300 principals derived from
deterministic keys, funded and staked — and reports:

| pass | runtime | read count | read length | write count |
| --- | --- | --- | --- | --- |
| STX leg (300 paid) | 0.2% | 14.1% | 0.1% | 6.0% |
| sBTC leg (300 paid) | 0.2% | **26.1%** | 1.5% | 10.0% |
| nothing due (300 skipped) | 0.1% | 6.1% | 0.1% | 0% |

as a share of the block limit. `read_count` binds first, and 300 sits at about a
quarter of it on the heavier leg — so the bound is comfortable and there is room
to roughly quadruple it if a larger pool ever wants fewer transactions.

Note the sBTC leg is the *fallback*: each payout is a `contract-call?` into
sbtc-token, against a native `stx-transfer?` on the STX path. That is why it
costs ~1.9× the reads. It is not worth optimising with `transfer-many` (whose
own list bound is 200, and would force the batch down) for a path that only
fires when the operator has been absent for three days.

---

## 11. Balances, reserves and dust

The contract holds two assets. Each gets an explicit liability counter so an
admin sweep can never reach stacker funds.

| asset | held for | liability vars | sweepable |
| --- | --- | --- | --- |
| sBTC | accrued fees + pot not yet swapped or paid out | `earned-fees`, `unswapped-sats` | `balance − earned-fees − unswapped-sats` |
| STX | swapped proceeds not yet paid out | `unpaid-stx` | `stx-balance − unpaid-stx` |

`unswapped-sats` covers both a pot mid-swap and a timed-out pot awaiting sBTC
distribution, so the fallback path needs no separate counter.

- `withdraw-fees(amount, recipient)` — admin; sends sBTC, capped at `earned-fees`.
- `sweep-sbtc-dust(recipient)` / `sweep-stx-dust(recipient)` — admin; send only
  the sweepable amount above.

### The pro-rata dust is stranded, on purpose

Every pro-rata split floors, so a cycle's payouts sum to slightly less than what
came in. That remainder is **not** recoverable by either sweep, and this is a
deliberate trade rather than an oversight.

The liability counters are reduced only by what a stacker was actually paid, so
the floored-away remainder stays *inside* the liability and the sweep sees
nothing above it. Making it sweepable would mean computing
`stx-out − Σ floor(stx-out × sᵢ / D)` on chain, which needs a pass over every
stacker — and an admin-asserted "this cycle is fully distributed" shortcut would
be exactly the hole the counters exist to close.

The cost is under one micro-STX (and under one satoshi) per stacker per cycle:
for 300 stackers over 100 cycles, roughly 0.03 STX. What the sweeps do recover
is anything that arrived outside the reward path — a stray transfer to the
contract. `tests/stx-rewards.test.ts` covers both halves: the remainder is
refused, a stray transfer is returned.

`stx-get-balance` counts locked STX, but this contract never locks STX (stackers
lock their own against it), so the STX figure is clean.

---

## 12. Admin and operator

Two distinct roles.

| role | set by | can do |
| --- | --- | --- |
| **admin** | `update-admin`, seeded to the deployer | set fees, manage the adapter allowlist, set the oracle and `max-slippage-bips`, withdraw fees, sweep dust, **set the operator** |
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

The operator is a **single mutable principal**, not a set. It is a hot key
running a keeper script, so it needs to be rotatable cheaply — one admin call,
and the old key is dead immediately. The `(is-eq contract-caller tx-sender)`
clause means the operator's authority cannot be borrowed by an intermediate
contract.

The operator can only choose *when, where and at what price* to swap, and only
inside the window and above the baseline floor. It can never move stacker funds:
the `as-contract?` allowance caps the sBTC, the balance-delta measurement fixes
the STX, and distribution is permissionless and formula-driven.

---

## 13. Security

- **`swap-rewards` must not be permissionless.** With a caller-supplied
  `min-stx-out`, anyone could set it to 1, sandwich the call, and take the pot.
  Operator-gating is the primary defence; the §8 baseline floor is the secondary
  one that bounds a *compromised operator key*.
- **Claiming, pinning, repairing and distributing all stay open to anyone**, so a
  disappeared operator can only delay the swap — never strand funds. After three
  days the pot pays out as sBTC without any privileged action at all.
- **A trait parameter is not authorization** — check `(contract-of adapter)`
  against the allowlist, and `(contract-of oracle)` against the pinned oracle
  principal.
- **Treat the adapter as untrusted** within its `as-contract?` allowance, and
  credit stackers from the measured balance delta rather than its return value.
- **No DEX call inside the distribution loop.**
- **`validate-stake!` is pox-5-only**, and refuses bonds and calldata outright.
- **Shares are frozen at pinning**, so nobody can stake into — or repair — a
  cycle whose price is already being determined.
- **The mirror check is a retryable gate, never a trap.** It sits on `pin-shares`
  rather than on `claim-rewards`, so a drifted mirror delays settlement by one
  repair transaction instead of locking the pot inside pox-5.

---

## 14. Testing

Neither ALEX, Bitflow nor Velar has liquidity in simnet, so the strategy is
split:

- **`contracts/mock-dex-adapter.clar`** — admin-settable fixed rate, pre-funded
  with STX, with injectable failure modes: under-delivers against
  `min-stx-out`, delivers nothing, reverts. This drives every unit test.
- **`contracts/price-oracle-dummy.clar`** — doubles as the test oracle, so the
  §8 floor is exercised deterministically in both directions.
- **Mainnet-fork tests** are the only way to validate the real adapters' call
  shapes. Pull each venue in through Clarinet `requirements`, as the sBTC suite
  already is. Budget for this: a transposed argument in an ALEX `swap-helper` or
  a Bitflow DLMM bin parameter is not catchable against a mock.

Cases that must be covered:

- pro-rata split across many stackers; sum of payouts + dust == `stx-out`
- partial swap → distribute → second `claim-rewards` → second swap → distribute
  again pays exactly the increment
- repeated `distribute-rewards` for the same stacker is a no-op
- **timeout**: no swap at all → after `SWAP_WINDOW_BURN_BLOCKS` everyone is paid
  sBTC net of fees, and `swap-rewards` is refused
- **partial timeout**: half swapped, window closes → both legs non-zero, in the
  same proportion for every stacker, and the two totals reconcile to the pot
- sBTC leg is **zero** while the window is still open, even with an unswapped
  remainder
- mirror drift after a mid-lock unstake → `pin-shares` fails →
  `repair-mirror-many` → `pin-shares` succeeds → distribution is correct
- `repair-mirror-many` and `validate-stake!` both refuse a pinned cycle
- `min-stx-out` below the baseline floor → `ERR_MIN_OUT_TOO_LOW`; wrong oracle
  principal rejected
- bond stake and calldata stake both rejected in `validate-stake!`
- non-allowlisted adapter rejected; non-operator caller rejected
- adapter under-delivering → whole transaction reverts, no state moved
- fee is exactly `fee-bips` of the pot, in sBTC, across both legs, and
  withdrawable
- neither sweep can touch `unswapped-sats`, `earned-fees` or `unpaid-stx`
- operator rotation: old operator immediately loses `swap-rewards`
- **cost benchmark for a 300-stacker `distribute-rewards-many`** (both legs)

---

## 15. Off-chain keeper

`scripts/swap-and-distribute.mjs`, run once per cycle:

1. `claim-rewards(cycle)`
2. `check-mirror(cycle)`; if it does not match, `repair-mirror-many` the
   diverged stackers, then `pin-shares(cycle)`
3. read `get-swap-status(cycle)` → sats remaining, and burn blocks left in the
   window
4. quote all four adapters for the full size **and** for candidate splits —
   Bitflow DLMM and standard need quoting separately, since the whole point of
   carrying both is that their impact curves diverge with size
5. choose the split minimising total price impact;
   `min-out = quote × (1 − slippage-bips)`, well above the §8 floor
6. broadcast one `swap-rewards` per leg, with post-conditions — sBTC out
   `<= amount-sats`, STX in `>= min-stx-out`
7. re-read `get-swap-status`; once the pot is fully swapped, page through
   `distribute-rewards-many` in batches of 300

The keeper should alert loudly if a cycle reaches, say, half its window
unswapped. Hitting the deadline is a fallback, not an outcome to be relaxed
about: stackers who chose this contract chose STX.

`bootstrap.mjs` subcommands to add: `pin`, `repair-mirror`, `swap`,
`swap-status`, `distribute`, `set-operator`.

---

## 16. Contract surface

```clarity
;; pox-5 callback
validate-stake!            (stacker, first-index, num-indexes, amount-ustx,
                            amount-sats, is-bond, signer-calldata)  ;; pox-5 only

;; cycle lifecycle
claim-rewards              (reward-cycle)                            ;; anyone
repair-mirror-many         (stackers, reward-cycle)                  ;; anyone
pin-shares                 (reward-cycle)                            ;; anyone
swap-rewards               (reward-cycle, adapter, oracle,
                            amount-sats, min-stx-out)                ;; operator
distribute-rewards         (stacker, reward-cycle)                   ;; anyone
distribute-rewards-many    (stackers, reward-cycle)                  ;; anyone

;; admin
update-admin               (admin, enabled)
set-operator               (new-operator)
update-fees                (new-fees-bips)
set-dex-adapter            (adapter, enabled)
set-price-oracle           (oracle)
set-max-slippage-bips      (bips)
set-enforce-price-floor    (enabled)
withdraw-fees              (amount, recipient)
sweep-sbtc-dust            (recipient)
sweep-stx-dust             (recipient)
register-self              (signer-manager, signer-key, auth-id, signer-sig)

;; read-only
get-stacker-rewards        (stacker, reward-cycle)
       -> { stx-entitled, stx-paid, stx-due, sbtc-due, sbtc-fee }
get-swap-status            (reward-cycle)
       -> { pot-sats, swapped-sats, remaining-sats, fee-sats, stx-out,
            total-shares, pinned, deadline, window-open }
check-mirror               (reward-cycle) -> { local, pox-5, matches }
get-mirrored-shares        (stacker, reward-cycle)
get-mirrored-total-shares  (reward-cycle)
get-fee-bips-for-cycle     (reward-cycle)
get-operator               ()
get-price-oracle           ()
get-max-slippage-bips      ()
get-enforce-price-floor    ()
is-admin                   (caller)
is-dex-adapter             (adapter)
get-earned-fees            ()
get-unswapped-sats         ()
get-unpaid-stx             ()
```

### Error codes

```
u1001 ERR_UNAUTHORIZED_ADMIN          u1010 ERR_SWAP_WINDOW_CLOSED
u1002 ERR_UNAUTHORIZED_OPERATOR       u1011 (unused)
u1003 ERR_UNAUTHORIZED_CALLER         u1012 ERR_SHARES_ALREADY_PINNED
u1004 ERR_INVALID_FEES_BIPS           u1013 ERR_NOTHING_TO_DISTRIBUTE
u1005 ERR_INSUFFICIENT_FEES           u1014 ERR_NO_DUST
u1006 ERR_ADAPTER_NOT_ALLOWED         u1015 ERR_BONDS_NOT_SUPPORTED
u1007 ERR_SLIPPAGE                    u1016 ERR_CALLDATA_NOT_SUPPORTED
u1008 ERR_SHARE_MIRROR_MISMATCH       u1017 ERR_MIN_OUT_TOO_LOW
u1009 ERR_SWAP_EXCEEDS_POT            u1018 ERR_WRONG_ORACLE
                                      u1019 ERR_INVALID_LOCK_PERIOD
                                      u1020 ERR_CYCLE_NOT_CLAIMED
                                      u1021 ERR_NO_BASELINE
```

u1011 was reserved for a "shares not pinned" failure that the implementation
does not need: `pin-shares` is idempotent and every path that needs a
denominator calls it implicitly.

---

## 17. Phasing

| phase | content | status |
| --- | --- | --- |
| 1 | `validate-stake!`, share mirror, `repair-mirror-many`, `pin-shares`, `claim-rewards` + deadline, admin/operator roles, read-onlys, tests | **done** |
| 2 | adapter trait, allowlist, mock adapter, dummy oracle, slippage floor, `swap-rewards` | **done** |
| 3 | `distribute-rewards` / `-many` (both legs), reserves, sweeps, 300-stacker cost benchmark | **done** |
| 4 | real adapters — Bitflow DLMM + Bitflow standard, type-checked against live mainnet ABIs | **done**; ALEX and Velar blocked, see §7 |
| 5 | keeper script (`scripts/stx-rewards.mjs`), mainnet build, deployment plan, runbook | **done** |
| 6 | miner-commit price oracle replacing the dummy | **done** — `price-oracle-jing.clar` wraps Jing's `get-native-price` |

Phase 6 landed earlier than planned: Jing's RFQ contract already computes the
miner-commit baseline from `get-tenure-info? miner-spend-total`, so the oracle
became a thin wrapper rather than a build. The dummy stays for tests and
testnet.

### Files

| file | what |
| --- | --- |
| `contracts/stx-rewards.clar` | the signer manager, deployed as `fastpool-stx-rewards` |
| `contracts/dex-traits.clar` | `dex-adapter-trait` and `price-oracle-trait` |
| `contracts/price-oracle-dummy.clar` | owner-set baseline, standing in until phase 6 |
| `contracts/mock-dex-adapter.clar` | test DEX with injectable failure modes |
| `tests/stx-rewards.test.ts` | 19 cases across the mirror, swap, window and sweep paths |
| `tests/bench-distribute-many.test.ts` | the 300-stacker cost benchmark |
| `tests/helpers/stx-rewards-fixture.ts` | simnet setup: stake, run the cycle out, arm the DEX |
| `contracts/dex-adapter-bitflow-dlmm.clar` | Bitflow DLMM, pinned to one pool |
| `contracts/dex-adapter-bitflow-xyk.clar` | Bitflow constant-product, pinned to one pool |
| `scripts/stx-rewards.mjs` | keeper: status, claim, mirror, repair, pin, quote, swap, distribute |
| `scripts/build-mainnet.mjs` | rewrites the pox-5 principal for mainnet, emits the deployment plan |
| `contracts/price-oracle-jing.clar` | production baseline: miner commits, via Jing's `get-native-price` |
| `docs/deploy-stx-rewards.md` | deployment runbook and operator guidance |

### How the adapters are verified without a fork

Clarinet cannot fork mainnet *state*, so the real pools have no liquidity in
simnet and cannot be executed in a test. What it can do is pull the real
contracts in as `requirements` and type-check against them — and because every
argument in both adapters is a **literal**, that check is meaningful: a
transposed argument, a wrong token, a wrong pool is a compile error.

Beyond that, the XYK adapter's exact argument tuple was executed against the
live mainnet pool through its read-only quote, returning a real price. The DLMM
adapter's shape is confirmed against the ABI and against decoded real swap
transactions. Runtime proof of the DLMM write path only comes from mainnet,
which is why the runbook's first live leg is a deliberately tiny one.

---

## 18. Open decisions

1. **When to switch the price floor on.** It ships off
   (`enforce-price-floor = false`), so `max-slippage-bips` is inert and no
   longer a launch blocker. Deciding to enable it means first gathering
   `baseline-ustx` vs `stx-out` from real swap prints and setting the tolerance
   from that data -- and accepting until then that only the operator's own
   `min-stx-out` bounds a compromised keeper key.
2. **Keeper alert threshold** on an unswapped cycle — how much of the 3-day
   window should elapse before it pages someone.
3. **ALEX and Velar.** ALEX needs a decision on whether a bridged-BTC hop is
   acceptable; Velar needs someone to confirm its router principal. Neither
   blocks launch — two working venues is enough to split across.
4. **Phase 6 trigger.** The miner-commit oracle assumes a fixed 1000 STX
   coinbase. If pox-6 changes emission, the baseline formula changes with it —
   worth deciding whether phase 6 waits on pox-6 rather than preceding it.
