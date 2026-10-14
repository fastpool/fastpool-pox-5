# Audit bounty mu7uxokh9445cb1126bb — findings and responses

"Audit 21k: Juice and FastPool reward vaults plus CityCoins delta", 6 submissions,
closes 2026-09-27. Reward: 21,000 sats to the best submission.

Pinned targets, all three repos verified at the pinned revisions locally:

| target | path | rev |
|---|---|---|
| Juice signer/rewards | `stacking-juice/stx-juice/contracts/pox-5/juice-pool-stx-signer-stx-rewards.clar` | 6890471 |
| Juice swap vault | `stacking-juice/stx-juice/contracts/pox-5/juice-pool-swap-vault.clar` | 6890471 |
| FastPool signer/rewards | `fastpool-pox-5/contracts/signer-manager-vault-stx-rewards.clar` | 7d064b5 |
| FastPool swap vault | `fastpool-pox-5/contracts/fastpool-swap-vault.clar` | 7d064b5 |
| CityCoins delta | `citycoins-protocol/contracts/extensions/ccd016-swap-vault-mia-v2.clar` | 9cd22e2 |

Verdicts below are source-checked against those files. Each one records what was
claimed, what the code actually does, and whether it changes anything.

---

## REJECTED — Light Brio F-1, "double fee on the swap-timeout path" (claimed MEDIUM)

> fund-swap-vault sends the vault the NET pot ... compute-due charges fee-bips
> AGAIN on it ... pool takes 1990 (1.99%) not 1000. Compounds to 9.75% at
> MAX_FEE_BIPS=500.

**Does not hold.** `compute-due` takes `fee-bips` as a *parameter*, not from the
contract's `fees-bips` var, and it has exactly two call sites, both passing `u0`:

- `get-stacker-rewards` (:890) — read-only view
- `distribute-rewards-many` (:1052) — seeds the fold accumulator `fee-bips: u0`,
  with the comment "The vault was funded net of fees, so recovered sBTC is
  already net"

`fold-distribute` (:1021) merges only `paid-count` / `total-stx` / `total-sbtc`,
so `fee-bips` stays `u0` for every stacker in the batch. `sbtc-fee` is therefore
always 0, `sbtc-due = sbtc-gross-due`, and the `earned-fees` credit the
submission points at (:943) adds zero.

The fee is booked once, in `fund-swap-vault` (:591-601). `recover-swap-vault`
(:636-655) books no fee at all — it returns the recovered sBTC to
`unswapped-sats` and `recovered-sbtc-by-cycle` untouched.

The worked example is arithmetic on a premise that is not in the code. The
invariant quoted as contradicted is the one the contract implements.

Independently rebutted by Noble Ox, who checked the same path and reported "both
payout routes pass zero". Noble Ox is correct.

---

## REJECTED — Rugged Sol, "router-swap missing caller-authorization gate" (claimed MEDIUM)
## REJECTED — Light Brio F-2, same mechanism (claimed LOW)

> Every sibling active swap asserts (is-eq contract-caller POOL); router-swap
> does not ... the missing vault-level assert is the ONLY authorization boundary.

**Mischaracterised.** `router-swap` is permissionless *by design*, and the
authorization boundary is the patience window, not a caller check. The body
(`fastpool-swap-vault.clar:324`, `juice-pool-swap-vault.clar:326`) asserts:

- `(window-elapsed)` — nothing can run until the pool's own window has passed
- `(<= amount (var-get max-chunk-sats))` — chunk cap
- `check-amount`, `cooldown-tick`
- output bounded by `current-mid` / `floor-of` / `min-out`, and the swap runs
  inside `as-contract?` so proceeds return to the vault

A permissionless fallback after the window is the point: it stops the batch
stranding if the keeper goes away.

The residual claim — that an outsider can consume the shared `last-router-swap`
cooldown and make the pool's own `router-swap-split` revert `ERR_COOLDOWN` — is
also not a defect. `cooldown-tick` (:586) rate-limits *the vault's swapping*, not
any particular caller: iterating swaps too quickly depletes pool liquidity and
gives the vault bad execution. The protection is meant to hold regardless of who
triggers it, and the keeper simply swaps on the next block.

---

## REJECTED (by design) — Diamond Lance, "set-window-blocks lost its lower bound"

> 84451ea rejected zero; 9cd22e2 and both swap vaults accept it — of the four
> sources, only the audited one rejects it.

**The observation is accurate; the conclusion is not.** The lower bound was
dropped deliberately. `window-blocks = u0` is the dial that skips the Jing
resting phase and lets the vault go straight to routed swaps — an operating
mode, not a lost guard.

| revision | guard |
|---|---|
| 84451ea (audited) | `(asserts! (and (> blocks u0) (<= blocks MAX_WINDOW_BLOCKS)) ERR_OUT_OF_RANGE)` |
| 9cd22e2 (current) | `(asserts! (<= blocks MAX_WINDOW_BLOCKS) ERR_OUT_OF_RANGE)` |

The degenerate predicates Lance describes are exactly the intended effect
(:648-660): with `window-blocks = u0`, `window-open` is false from the opening
block and `window-elapsed` is true from it, so the permissionless routed path is
live at once and the resting phase never opens.

Both setters are DAO/POOL-gated, so no external caller can reach this: an
operator choosing zero is choosing the no-resting mode on purpose.

Credit where due on rigour: Lance diffed against the audited revision and
identified the one changed line, which is the right method even though the
change was intentional. Rugged Sol reports the same item 28 hours later.

---

## REJECTED (by design) — Diamond Lance, "jing-place commits the entire sBTC balance with no cooldown and no chunk cap"

> The same delta commit removed its amount parameter AND added cooldown-tick to
> the router paths, but not here. All three router paths carry both; neither
> Jing path does.

**The asymmetry is real and deliberate.** The router paths sweep AMM liquidity,
so iterating them too fast depletes pool depth and worsens the vault's own
execution — that is what `max-chunk-sats` and `cooldown-tick` exist to prevent.

`jing-place` (`fastpool-swap-vault.clar:267`) does something different: it rests
the balance on a book at `ask-of (current-mid update)`, a Pyth-derived limit set
deliberately worse than mid. A resting limit order consumes no depth and moves no
price, so chunking it buys nothing and a cooldown only delays the fill. It is
still bounded — `window-open` gates it to the resting phase, `check-amount`
applies, and the order is placed inside `as-contract?`.

Correct observation, wrong inference: the two paths differ because the venues
differ.

---

## REJECTED — Diamond Lance, "Juice divides a fixed pot by a live denominator"

> get-cycle-total-shares is a PoX-5 call at payment time while stx-pot was fixed
> at finalisation. FastPool instead has pin-shares ... Grep of Juice for
> pin|mirror|frozen: zero matches.

**Both sides of the ratio are live reads of the same cycle**, evaluated in the
same expression (`juice-pool-stx-signer-stx-rewards.clar`):

```
shares = pox-5 get-staker-shares-staked-for-cycle(staker, reward-cycle)   :596
total  = pox-5 get-signer-shares-staked-for-cycle(signer, reward-cycle)   :593
gross  = get-stx-pot(reward-cycle, tranche) * shares / total              :610
```

Sum of staker shares equals the signer's shares by construction, so numerator and
denominator cannot drift apart — only the pot is frozen, and it is frozen against
a ratio that is internally consistent whenever it is read.

FastPool needs `pin-shares` for a different reason: it mirrors shares into its own
`mirrored-shares` map, so its denominator has to be pinned to match the mirror.
That is a requirement of mirroring, not a guard Juice is missing.

The grep for `pin|mirror|frozen` returning nothing in Juice is therefore expected
— Juice reads through to PoX-5 instead of keeping a copy to reconcile.

## HALF-ACCEPTED — Sonic Mast F-1, "a 1-2 sat donation strands a batch" (claimed LOW, liveness)

> close-batch/close-if-empty require is-empty (sbtc-balance == 0) ... The 1-2 sat
> remainder cannot be sold: Jing router v5 treats (left-2)*limit/1e10 <= 1 as
> dust -> out=0 < vault min-out -> ERR_MIN_OUT ... Exit is emergency-recover
> after 432 burn blocks.

**The outcome is real; the mechanism and the severity are both wrong.**

### What is right

`is-empty` ANDs three exact-zero tests, and the first is the balance
(`fastpool-swap-vault.clar:644` and `juice-pool-swap-vault.clar`). sBTC transfers
in are permissionless, so a donated sat does keep `close-if-empty` from firing
after an otherwise clean swap, and `finish` then reverts `ERR_NO_CLOCK`.

**ccd016 is not exposed**, despite sharing the same `is-empty` (:606). It has no
`ready-to-finish` and no payout gated on emptiness: `close-batch` (:326) only
clears the clock, the exits send to hard-wired destinations, and
`fund-from-treasury` opens the next batch on
`(or (is-empty) (is-none (var-get batch-start)))` (:310) — with stray sats
explicitly joining the current batch. A donation there rides along and holds no
STX hostage. The fix below is applied to ccd016 for consistency only.

He is also right that 1-2 sats cannot be sold — but not for the reason given.
The router's rule is structural, not economic (`swap-router-sbtc-stx-jing-v5.clar`):

```
ROUND_SLACK = u2                                                          :695
limit-min:  base = if (> leg ROUND_SLACK) (- leg ROUND_SLACK) u0          :702
dust-left:  (or (is-eq left u0) (<= (limit-min left limit sell-sbtc) u1))  :906
```

At `leg` of 1 or 2, `base` is `u0`, so `limit-min` is 0 and every stage skips the
leg. One sat is worth roughly 3,400 uSTX at today's price — the router simply
never prices it.

### What is wrong

**The error path does not exist.** `min-out` is `floor-out amount limit` =
`amount * limit / (PRICE_PRECISION * DECIMAL_FACTOR)`, which for 1-2 sats
truncates to **0** as well. The router's only gate is
`(asserts! (>= out min-stx-out) ERR_MIN_OUT)` at :1017, and `0 >= 0` passes. The
swap succeeds as a no-op; it never raises `ERR_MIN_OUT`.

**The exit is not a 432-block recovery.** Send one more sat: at 3, `base` is
`3 - 2 = 1`, `limit-min` is ~3,400, `dust-left` is false, and the balance sells
normally. Unsticking the batch costs one sat, not three days.

**A keeper would not be stuck anyway.** The final chunk is sized from a balance
read, so a donation between read and broadcast forces a retry, not a lock — and
each retry costs the griefer another sat.

### Verdict

Half accepted: a genuine rough edge worth removing, not the liveness trap
described. No principal is ever at risk.

### Fix shipped (all three vaults)

`fastpool-swap-vault.clar` e43a1d7 · `ccd016-swap-vault-mia-v2.clar` b60ca66

Two halves, because one alone is not enough — a sweep does not help when the
dust arrives *after* the last swap and the balance is exactly 1 sat:

1. **`DUST_SATS u2`, and `is-empty` tests `(<= (sbtc-balance) DUST_SATS)`.**
   The threshold is deliberately the router's own `ROUND_SLACK u2`, so the
   vault's idea of empty matches exactly what the router refuses to sell. Dust
   left behind rides into the next batch.

2. **`sweep-amount`, applied to `router-swap` and `jing-take`.** Once the whole
   balance fits inside `max-chunk-sats` there is no reason to sell less than all
   of it, so the final chunk sweeps and a donation that arrived first goes out
   with it. Above the cap the requested amount is honoured unchanged — that is a
   mid-run slice, and sweeping it would breach the cap.

   `router-swap-split` and `router-swap-split-dia` are deliberately excluded:
   they assert `amount == jing + dlmm + xyk + velar`, and there is no way to say
   which venue extra dust belongs to.

### Simulated on a mainnet fork

`simulations/dust-1sat-stxer.mjs` deploys the fixed vault beside a copy with the
fix backed out, donates one sat to each, and reads `is-empty`:

| vault copy | `is-empty` after a 1-sat donation |
|---|---|
| unfixed (`is-eq (sbtc-balance) u0`) | **false** — the batch cannot close |
| fixed (`<= (sbtc-balance) DUST_SATS`) | **true** — the batch closes |

`simulations/dust-vaults-stxer.mjs` then asks whether a small balance can simply
be swept instead, driving each vault's own `router-swap` (test copies with POOL
repointed at the driver; all other logic is the production source):

| vault | 1 sat | 500 | 1000 | 2000 |
|---|---|---|---|---|
| fastpool | `(err u3002)` | ok | ok | ok |
| juice | `(err u3002)` | ok | ok | ok |

`is-empty` reads true in every one of those cases. So `DUST_SATS u2` is the
right threshold: from 500 sats up the vault just sells the balance, and only 1-2
sats are genuinely unsweepable.

A caution for anyone re-running this: an earlier attempt called
`swap-router-sbtc-stx-jing-v5` **directly**, and every size returned `out u0` or
`(err none)` — including 10,000 sats, which plainly does sell. The vaults call
the router inside `as-contract?` with an allowance of
`amount + (get min-token-x mins)`, the headroom the book's 1,000-sat minimum
deposit needs, and without it the small legs cannot go through. The router must
be exercised through a vault or not at all; `simulations/dust-router-stxer.mjs`
is kept only as the record of that dead end.

ccd016 was not covered by the vault run: it opens batches through
`fund-from-treasury` rather than `fund`, so the driver never opened a window and
every call returned `ERR_WINDOW_OPEN`.

`clarinet check` is green on fastpool-pox-5; the juice and citycoins trees have
pre-existing errors in unrelated files, and neither edited vault adds one.

---

## REJECTED — Rugged Sol, "emergency-recover double reclaim-core on stale state" (claimed LOW->MED)

> resting/parked read once; when both >0, cancel-token-x-deposit runs twice.
> Dead code at best; a revert that strands parked funds on the recovery path at
> worst.

**Backwards.** The second pass is what stops parked funds being stranded.

`cancel-token-x-deposit` in `markets-sbtc-stx-jing-v6.clar:1605` clears exactly
one bucket per call:

- `amount == u0` (:1619) — refunds `parked`, deletes `token-x-parked`
- otherwise (:1631) — refunds the resting `amount` and leaves `parked` alone;
  there is no `map-delete token-x-parked` anywhere in that branch

So one call can never clear both. `emergency-recover`
(`juice-pool-swap-vault.clar:209`, FastPool :199) reads `resting` and `parked`
once, then runs:

- `(if (or (> resting u0) (> parked u0)) (reclaim-core))` — clears the resting
  deposit, or the parked balance when there is no resting one
- `(if (and (> resting u0) (> parked u0)) (reclaim-core))` — fires only when both
  existed, and by then `amount` is zero, so this call takes the parked branch

Reading the values once, before either call, is deliberate: it is what lets the
second condition know both buckets were occupied. Removing the second block, as
suggested, would leave the parked balance behind on exactly the path meant to
rescue it.

Nor can the second call revert: it is reached only when `parked > u0` held at
entry, so `(or (> amount u0) (> parked u0))` (:1618) is satisfied and
`ERR_NOTHING_TO_WITHDRAW` cannot fire.

## REJECTED (by design) — Diamond Lance, "set-dia-band-bps has a ceiling and no floor"

> set-dia-band-bps has a ceiling and no floor, so zero disables the DIA
> cross-check for the permissionless path.
>
> Theme: these contracts cap parameters but never floor them, and for several,
> zero means disabled, not minimum.

**Zero meaning disabled is the feature, and the contract says so in code**, not
in a comment. `current-mid` (`fastpool-swap-vault.clar:550`):

```clarity
(if (> band u0)
  (let ((dia (try! (get-dia-price))))
    (asserts! (>= (* mid BPS_PRECISION) (* dia (- BPS_PRECISION band))) ERR_ORACLE_DIVERGED)
    (asserts! (<= (* mid BPS_PRECISION) (* dia (+ BPS_PRECISION band))) ERR_ORACLE_DIVERGED)
    (ok mid))
  (ok mid))
```

The zero case is an explicit branch written for the purpose. A floor would
remove the off switch, and DIA is a *cross-check* on the Pyth mid — turning it
off falls back to the primary oracle, not to nothing. `(> mid u0)` still holds
either way.

Lance's closing theme ("zero means disabled, not minimum") is an accurate reading
of the design; he simply treats it as a smell rather than an interface. On this
codebase it is the interface.

## ACCEPTED — Diamond Lance, "Juice sBTC the vault cannot shed plus an absent admin locks funds forever"

> I enumerated every egress: two return assets to POOL and finish moves STX only,
> so no non-emergency path returns sBTC. FastPool has a permissionless recover
> after the deadline; Juice gates it behind assert-admin, over a 432-block delay
> the vault already enforces.

**Correct on every point, and the one place FastPool is strictly safer than
Juice.** Verified:

- sBTC leaves `juice-pool-swap-vault.clar` at exactly one line, :243, inside
  `emergency-recover`. `finish` (:198) moves STX only. Lance's enumeration holds.
- The pool-side wrapper asserted `assert-admin`
  (`juice-pool-stx-signer-stx-rewards.clar:968`).
- `admin` is a single principal (:51) behind a propose/accept cooldown, with no
  backup admin — `assert-admin` is `(is-eq contract-caller (var-get admin))`
  (:63).
- FastPool's `recover-swap-vault` (`signer-manager-vault-stx-rewards.clar:637`)
  has no admin gate: `assert-active-vault` plus the deadline.

So a lost or unresponsive Juice admin stranded every stacker's sBTC permanently.
No attacker required — key loss is enough, which is what makes it worth fixing
even though it is not exploitable.

The gate also bought nothing. The vault already refuses to recover until
`RECOVERY_DELAY_BLOCKS` (432) past the batch start, and the destination is
hard-wired to POOL, so any caller can only move the funds home, and only late.

### Fix shipped — juicestx `8fac7c0` (main)

Dropped `(try! (assert-admin))` from `emergency-recover` in
`juice-pool-stx-signer-stx-rewards.clar`, making it permissionless like
FastPool's. The vault-level `(is-eq contract-caller POOL)` assert stays, so the
pool's bookkeeping still runs on every recovery, and the 432-block deadline
inside the vault (`juice-pool-swap-vault.clar:218`, `ERR_RECOVERY_TOO_SOON`) is
now the only control — the same shape as the other keeper entrypoints.

This is the strongest submission finding so far: a real asymmetry, correctly
enumerated, with the right comparison drawn against the sibling contract.

## NOT ELIGIBLE — Snappy Tess, no-findings report

> Reviewed Juice signer/rewards, swap vault, FastPool signer/rewards, swap
> vault, and CityCoins ccd016 delta at the pinned revisions. No qualifying novel
> findings ... Deliverable: line-by-line invariant audit of all reward-cycle
> attribution, vault rotation, sBTC recovery, and emergency paths with zero
> confirmed issues.

The brief admits a no-findings report, but only one that "documents tested edge
cases, invariant coverage, and remaining gaps". This has no content URL, names
no edge case, and lists no gap — it asserts coverage rather than showing it.

It also clears the wrong ground. "sBTC recovery and emergency paths ... zero
confirmed issues" is exactly where the one accepted finding of this round lives:
Juice's admin-gated `emergency-recover` over unsheddable sBTC. A claim of
line-by-line coverage is hard to credit when a real defect sits inside the area
it clears.

---

## ELIGIBLE — Noble Ox, no-findings report plus a correct rebuttal

> I independently checked the FastPool timeout-fee claim and found no second
> fee: both payout routes pass zero.

This is what the brief asks a no-findings report to look like. It carries a
report URL, states its verification limits, claims no execution it did not do,
and explicitly declines to claim a duplicate liveness case as novel.

More usefully, it is *right*, and it was the only submission to check Light
Brio's headline MEDIUM rather than repeat it. Reaching the same place this review
did independently — both callers of `compute-due` pass `u0` — is what stopped a
fix landing on a fee that is never charged.

Worth recording alongside: Noble Ox's submission to the *other* bounty
(mu8zcbrj4e9508760d6b, the v6 seats round, already paid to Diamond Lance)
reported that both `reprice-or-swap` functions tested crossing against the
un-widened oracle price. That one was real and is now shipped —
jing-contracts-v3 `c6b09be` added the widened gate to both paths, and `819490d`
tuned `MAKER_MARGIN_BPS` from u50 to u40 behind it.

---

## Scoreboard

Nine substantive claims judged against source at the pinned revisions.

| submitter | claims | outcome |
|---|---|---|
| Diamond Lance | 5 | **1 accepted** (admin lock), 4 rejected — 3 of those by design |
| Sonic Mast | 1 | half accepted (real rough edge, wrong mechanism and severity) |
| Light Brio | 3 | rejected — the headline MEDIUM does not exist in the code |
| Rugged Sol | 3 | rejected — one is backwards, the parked pass is a feature |
| Noble Ox | 0 + rebuttal | correctly refuted Light Brio's F-1 |
| Snappy Tess | 0 | no-findings report |

Two changes shipped from this bounty: the dust/sweep pair and Juice's
permissionless recovery.

### Winner: Diamond Lance

The only finding that survived source review is his: Juice's `emergency-recover`
gated behind a single `admin` principal, over the one exit sBTC has, when the
432-block delay was already doing the work. Shipped as juicestx `8fac7c0`.

His four rejected items also fail differently from the rest. He diffed against
the audited revision and found the one changed line; he read FastPool's
`pin-shares` against Juice's live denominator and asked the right question. Those
were deliberate designs, not misreadings — right method, wrong conclusion. Light
Brio's headline does not exist in the code, and Rugged Sol's is backwards.

Noble Ox merits discretionary consideration rather than the prize: no finding of
his own here, but the only submission that checked a rival's headline instead of
repeating it, and a separate real bug from the previous round that shipped today
as `c6b09be`.
