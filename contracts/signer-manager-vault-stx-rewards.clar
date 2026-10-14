;; title: fastpool-stx-rewards-signer-manager
;; A FAST Pool signer manager for pox-5 that pays stacking rewards in STX.
;;
;; pox-5 pays a pool's rewards in sBTC. This contract claims that pot, swaps it
;; for STX on one or more DEXs, and distributes the STX to its stackers
;; pro-rata. Everyone locked against this contract receives STX at the same
;; execution price; there is no per-stacker reward preference. A stacker who
;; wants sBTC or L1 bitcoin stakes against a different FAST Pool signer manager
;; instead.
;;
;; A cycle moves through four steps:
;;
;;   1. claim-rewards   (anyone)   pox-5 -> here and records the cycle pot.
;;   2. pin-shares      (anyone)   freeze the pro-rata denominator.
;;   3. fund-swap-vault (anyone)   send the cycle's net sBTC to its vault.
;;   4. finalize-swap-vault        attribute returned STX to the cycle.
;;   5. distribute-*    (anyone)   pay stackers.
;;
;; STX stacking only. Bond stacking and pox-addr calldata are both refused in
;; `validate-stake!`.
;;
;; See docs/plan-fastpool-stx-rewards.md for the full design rationale.

(impl-trait 'SP000000000000000000002Q6VF78.pox-5.signer-manager-trait)
(use-trait signer-manager-trait 'SP000000000000000000002Q6VF78.pox-5.signer-manager-trait)
(use-trait swap-vault-interface 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.juice-swap-vault-trait-v2.swap-vault-trait)

;;; Errors

;; Attempted an admin-only function.
(define-constant ERR_UNAUTHORIZED_ADMIN (err u1001))
;; A pox-5 callback (`validate-stake!`) was invoked by a principal other than
;; the pox-5 contract.
(define-constant ERR_UNAUTHORIZED_CALLER (err u1003))
;; Fee rate is not a valid basis-point value.
(define-constant ERR_INVALID_FEES_BIPS (err u1004))
;; Tried to withdraw more fees than have accrued.
(define-constant ERR_INSUFFICIENT_FEES (err u1005))
;; The local share mirror disagrees with pox-5's signer total, so the pro-rata
;; denominator cannot be trusted. Repairable -- see `repair-mirror-many`.
(define-constant ERR_SHARE_MIRROR_MISMATCH (err u1008))

;; u1011 is unused: `pin-shares` is idempotent and called implicitly by every
;; path that needs a denominator, so there is no "not pinned yet" failure.
;; The cycle's shares are already pinned and can no longer be changed.
(define-constant ERR_SHARES_ALREADY_PINNED (err u1012))
;; This stacker has nothing payable for this cycle.
(define-constant ERR_NOTHING_TO_DISTRIBUTE (err u1013))
;; There is no sweepable dust.
(define-constant ERR_NO_DUST (err u1014))
;; Bond stacking is not supported by this signer manager.
(define-constant ERR_BONDS_NOT_SUPPORTED (err u1015))
;; Staking calldata (a pox-addr for L1 payouts) is not supported here.
(define-constant ERR_CALLDATA_NOT_SUPPORTED (err u1016))
;; pox-5 asked to mirror more cycles than a lock can cover.
(define-constant ERR_INVALID_LOCK_PERIOD (err u1019))
;; `claim-rewards` has not run for this cycle, so there is nothing to settle.
(define-constant ERR_CYCLE_NOT_CLAIMED (err u1020))
(define-constant ERR_VAULT_BUSY (err u1050))
(define-constant ERR_ZERO_VAULT_FUNDING (err u1051))
(define-constant ERR_RECOVERY_TOO_SOON (err u1052))
(define-constant ERR_NO_ACTIVE_VAULT (err u1053))
(define-constant ERR_NO_PENDING_SWAP_VAULT (err u1054))
(define-constant ERR_INVALID_SWAP_VAULT (err u1055))
(define-constant ERR_SWAP_VAULT_BUSY (err u1056))
(define-constant ERR_SWAP_VAULT_COOLDOWN (err u1057))

;;; Constants

(define-constant MAX_BIPS u10000)
(define-constant SWAP_VAULT_COOLDOWN u4032)

;; The signer allows recovery after 432 burn blocks from the cycle's first claim.
;; The vault accepts recovery only when this signer manager calls it.
(define-constant SWAP_WINDOW_BURN_BLOCKS u432)

;; pox-5 caps a lock at 96 cycles (`MAX_NUM_CYCLES`, `check-pox-lock-period`).
;; Bounty mv7dfb (Void Cannon): the old 12-entry list refused longer locks.
(define-constant CYCLE_OFFSETS (list u0 u1 u2 u3 u4 u5 u6 u7 u8 u9 u10 u11 u12
  u13 u14 u15 u16 u17 u18 u19 u20 u21 u22 u23 u24 u25 u26 u27 u28 u29 u30 u31
  u32 u33 u34 u35 u36 u37 u38 u39 u40 u41 u42 u43 u44 u45 u46 u47 u48 u49 u50
  u51 u52 u53 u54 u55 u56 u57 u58 u59 u60 u61 u62 u63 u64 u65 u66 u67 u68 u69
  u70 u71 u72 u73 u74 u75 u76 u77 u78 u79 u80 u81 u82 u83 u84 u85 u86 u87 u88
  u89 u90 u91 u92 u93 u94 u95))

;;; Roles

;; Admins set fees, withdraw fees, sweep dust, and manage the swap vault.
;; Deployer is seeded as the first admin.
(define-map admins
  principal
  bool
)
(map-set admins tx-sender true)

;;; Fees
;;
;; Fees are taken in sBTC when `fund-swap-vault` sends the cycle's net reward
;; into the dedicated vault.

(define-data-var fees-bips uint u0)
(define-data-var earned-fees uint u0)

;; The rate in force when a cycle was first claimed, so a later fee change
;; never applies retroactively to a cycle already in flight.
(define-map fee-bips-for-cycle
  uint
  uint
)

;;; Reserves
;;
;; The contract holds two assets, and each gets an explicit liability counter so
;; an admin sweep can never reach stacker funds.

;; sBTC pulled in from pox-5 that has neither been swapped nor paid out.
;; Covers both a pot mid-swap and a timed-out pot awaiting sBTC distribution.
(define-data-var unswapped-sats uint u0)

;; Micro-STX received from swaps that has not yet been paid to a stacker.
(define-data-var unpaid-stx uint u0)

;;; Share mirror
;;
;; Every `contract-call?` into pox-5 is charged its full ~135KB source as
;; `read_length`, whatever the function does, so asking pox-5 for each
;; stacker's share would cap a distribution at a few hundred stackers per
;; block. Instead the shares are mirrored here.
;;
;; pox-5 calls `validate-stake!` on every path that INCREASES a stacker's
;; shares, which is enough to maintain the mirror. It never calls back on
;; `unstake`, so the mirror can drift -- but only ever upward, since every
;; unseen change is a decrease. That one-sidedness is what makes a single
;; signer-level equality check against pox-5 sufficient proof of exactness:
;; see `pin-shares`.

(define-map mirrored-shares
  {
    stacker: principal,
    reward-cycle: uint,
  }
  uint
)

(define-map mirrored-total-shares
  uint
  uint
)

;;; Per-cycle settlement

(define-map cycle-settlement
  uint
  {
    ;; gross sBTC pulled in from pox-5 for this cycle
    pot-sats: uint,
    ;; of `pot-sats`, how much has been committed to a swap (fee included)
    swapped-sats: uint,
    ;; fees taken on the swapped portion
    fee-sats: uint,
    ;; micro-STX received across all swap legs
    stx-out: uint,
    ;; the pinned pro-rata denominator
    total-shares: uint,
    ;; burn height after which the swap window is closed
    deadline: uint,
    pinned: bool,
  }
)

(define-constant EMPTY_SETTLEMENT {
  pot-sats: u0,
  swapped-sats: u0,
  fee-sats: u0,
  stx-out: u0,
  total-shares: u0,
  deadline: u0,
  pinned: false,
})

;;; Payout watermarks
;;
;; Both are monotone. When more of a pot is claimed or swapped later, the
;; entitlement grows and the next distribution pays exactly the difference, so
;; repeated calls for the same stacker are safe and idempotent.

;; Micro-STX already paid to a stacker for a cycle.
(define-map stacker-stx-paid
  {
    stacker: principal,
    reward-cycle: uint,
  }
  uint
)

;; Gross sats already accounted to a stacker for a cycle on the timeout path.
(define-map stacker-sbtc-accounted
  {
    stacker: principal,
    reward-cycle: uint,
  }
  uint
)

;;; ---------------------------------------------------------------------------
;;; pox-5 callback
;;; ---------------------------------------------------------------------------

;; Record a stacker's shares for one cycle, keeping `mirrored-total-shares` in
;; step. pox-5 stores shares as an absolute per-cycle amount, so a re-stake
;; overwrites rather than adds, and the running total moves by the difference.
;;
;; A cycle whose shares are already pinned is skipped: its pot has been priced
;; and divided, so late shares must not dilute it. Skipping rather than failing
;; means a new stake is never blocked by an old settled cycle.
(define-private (mirror-stake-for-cycle
    (offset uint)
    (acc {
      stacker: principal,
      first-reward-cycle: uint,
      shares: uint,
    })
  )
  (let ((reward-cycle (+ (get first-reward-cycle acc) offset)))
    (if (is-pinned reward-cycle)
      acc
      (let (
          (stacker (get stacker acc))
          (shares (get shares acc))
          (previous (default-to u0
            (map-get? mirrored-shares {
              stacker: stacker,
              reward-cycle: reward-cycle,
            })
          ))
          (total (default-to u0 (map-get? mirrored-total-shares reward-cycle)))
        )
        (map-set mirrored-shares {
          stacker: stacker,
          reward-cycle: reward-cycle,
        }
          shares
        )
        ;; `total` always includes `previous`, so this cannot underflow.
        (map-set mirrored-total-shares reward-cycle (+ (- total previous) shares))
        acc
      )
    )
  )
)

;; Callback from a pox-5 `stake` / `stake-update`. Authorizes the stacker and
;; mirrors the shares the stake grants.
;;
;; `is-bond` and `signer-calldata` are both refused rather than ignored: a
;; stacker who meant to earn sBTC through a bond, or L1 bitcoin through a
;; pox-addr, gets a clean failure at pox-5 instead of silently receiving STX.
(define-public (validate-stake!
    (stacker principal)
    (first-index uint)
    (num-indexes uint)
    (amount-ustx uint)
    (amount-sats uint)
    (is-bond bool)
    (signer-calldata (optional (buff 500)))
  )
  (begin
    (try! (authorize-pox-5))
    (asserts! (not is-bond) ERR_BONDS_NOT_SUPPORTED)
    (asserts! (is-none signer-calldata) ERR_CALLDATA_NOT_SUPPORTED)
    (fold mirror-stake-for-cycle
      (unwrap! (slice? CYCLE_OFFSETS u0 num-indexes) ERR_INVALID_LOCK_PERIOD) {
      stacker: stacker,
      first-reward-cycle: first-index,
      shares: amount-ustx,
    })
    (print {
      topic: "validate-stake",
      stacker: stacker,
      first-reward-cycle: first-index,
      num-cycles: num-indexes,
      shares: amount-ustx,
      amount-sats: amount-sats,
    })
    (ok true)
  )
)

;;; ---------------------------------------------------------------------------
;;; 1. Claim the pot
;;; ---------------------------------------------------------------------------

;; Pull a cycle's sBTC out of pox-5 and start its swap window.
;;
;; Permissionless. A cycle can be claimed repeatedly as rewards accrue, so the
;; pot accumulates; only the first claim sets the fee rate and the deadline.
;;
;; There is deliberately no mirror check here. A drifted mirror is a normal
;; event (see `repair-mirror-many`) and must never be able to strand the pot
;; inside pox-5 -- the check lives on `pin-shares`, which is retryable.
;;
;; This contract never calls pox-5's `claim-staker-rewards-for-signer`. pox-5's
;; internal per-stacker ledger is left un-zeroed by design; the mirror here is
;; authoritative. Because the pox-5 settlement path is not exposed at all, the
;; two can never be mixed and no double payout is possible.
(define-public (claim-rewards (reward-cycle uint))
  (let (
      (result (try! (contract-call? 'SP000000000000000000002Q6VF78.pox-5
        claim-rewards (list) reward-cycle
      )))
      (earned (get total-rewards result))
      (settlement (get-settlement reward-cycle))
      (first-claim (is-eq (get deadline settlement) u0))
      (deadline (if first-claim
        (+ burn-block-height SWAP_WINDOW_BURN_BLOCKS)
        (get deadline settlement)
      ))
    )
    (var-set unswapped-sats (+ (var-get unswapped-sats) earned))
    (if first-claim
      (map-set fee-bips-for-cycle reward-cycle (var-get fees-bips))
      true
    )
    (map-set cycle-settlement reward-cycle
      (merge settlement {
        pot-sats: (+ (get pot-sats settlement) earned),
        deadline: deadline,
      }))
    (print {
      topic: "claim-rewards",
      reward-cycle: reward-cycle,
      earned: earned,
      pot-sats: (+ (get pot-sats settlement) earned),
      deadline: deadline,
    })
    (ok earned)
  )
)

;;; ---------------------------------------------------------------------------
;;; 2. Pin the denominator
;;; ---------------------------------------------------------------------------

;; Correct the mirror for stackers whose shares pox-5 has since reduced.
;;
;; pox-5's `unstake` removes a stacker from cycles starting at
;; `current-cycle + 1`, and never calls back here. So a stacker who locked for
;; cycles 10-15 and unstaked during cycle 12 was removed from 13, 14 and 15
;; while those were still future -- and this contract never saw it. When cycle
;; 13 later ends and is claimed, the mirror for it is high and `pin-shares`
;; will fail. That is expected, not a bug, which is why the repair is
;; permissionless and the check it feeds is a retryable gate.
;;
;; Costs one pox-5 call per stacker, so the list is bounded well below the
;; distribution batch size. In practice only stackers who unstaked mid-lock
;; need repairing, and the keeper can identify exactly which ones with
;; read-only calls before spending a transaction.
(define-public (repair-mirror-many
    (stackers (list 100 principal))
    (reward-cycle uint)
  )
  (begin
    (asserts! (not (is-pinned reward-cycle)) ERR_SHARES_ALREADY_PINNED)
    (let (
        (summary (fold fold-repair-mirror stackers {
          reward-cycle: reward-cycle,
          removed: u0,
          added: u0,
        }))
        (total (default-to u0 (map-get? mirrored-total-shares reward-cycle)))
      )
      ;; `total` is the sum of every mirrored share, so it always covers
      ;; `removed` and this cannot underflow.
      (map-set mirrored-total-shares reward-cycle
        (+ (- total (get removed summary)) (get added summary))
      )
      (print {
        topic: "repair-mirror",
        reward-cycle: reward-cycle,
        removed: (get removed summary),
        added: (get added summary),
      })
      (ok {
        removed: (get removed summary),
        added: (get added summary),
      })
    )
  )
)

(define-private (fold-repair-mirror
    (stacker principal)
    (acc {
      reward-cycle: uint,
      removed: uint,
      added: uint,
    })
  )
  (let (
      (reward-cycle (get reward-cycle acc))
      (truth (contract-call? 'SP000000000000000000002Q6VF78.pox-5
        get-staker-shares-staked-for-cycle stacker reward-cycle none
        current-contract
      ))
      (previous (default-to u0
        (map-get? mirrored-shares {
          stacker: stacker,
          reward-cycle: reward-cycle,
        })
      ))
    )
    (if (is-eq truth previous)
      acc
      (begin
        (map-set mirrored-shares {
          stacker: stacker,
          reward-cycle: reward-cycle,
        }
          truth
        )
        ;; The drift is always downward in practice; the upward arm exists so
        ;; the running total stays exact whatever pox-5 reports.
        (if (> previous truth)
          (merge acc { removed: (+ (get removed acc) (- previous truth)) })
          (merge acc { added: (+ (get added acc) (- truth previous)) })
        )
      )
    )
  )
)

;; Freeze the pro-rata denominator for a cycle against pox-5's own signer
;; total.
;;
;; Because the mirror can only ever be too high, equality here proves it is
;; exact. This is the single pox-5 call the whole settlement path makes: once
;; pinned, swapping and distributing touch pox-5 not at all.
;;
;; Pinning also closes the cycle to further share changes -- `validate-stake!`
;; skips it and `repair-mirror-many` refuses it -- so nothing can move under a
;; pot whose price is already being determined.
;;
;; Permissionless and idempotent, so `swap-rewards` and `distribute-*` can call
;; it implicitly. It exists as its own entry point mainly so that a mirror
;; mismatch surfaces as an isolated, obvious failure rather than a confusing
;; revert inside a swap.
(define-public (pin-shares (reward-cycle uint))
  (let ((settlement (get-settlement reward-cycle)))
    (asserts! (> (get deadline settlement) u0) ERR_CYCLE_NOT_CLAIMED)
    (if (get pinned settlement)
      (ok (get total-shares settlement))
      (let ((local (default-to u0 (map-get? mirrored-total-shares reward-cycle))))
        (asserts!
          (is-eq local
            (contract-call? 'SP000000000000000000002Q6VF78.pox-5
              get-signer-pending-staked-ustx-per-cycle current-contract
              reward-cycle
            ))
          ERR_SHARE_MIRROR_MISMATCH
        )
        (map-set cycle-settlement reward-cycle
          (merge settlement {
            total-shares: local,
            pinned: true,
          }))
        (print {
          topic: "pin-shares",
          reward-cycle: reward-cycle,
          total-shares: local,
        })
        (ok local)
      )
    )
  )
)

;;; Dedicated swap vault

(define-data-var swap-vault principal .fastpool-swap-vault)
(define-data-var pending-swap-vault (optional principal) none)
(define-data-var pending-swap-vault-height uint u0)

(define-read-only (get-swap-vault)
  (var-get swap-vault)
)

(define-read-only (get-pending-swap-vault)
  {
    vault: (var-get pending-swap-vault),
    proposed-at: (var-get pending-swap-vault-height),
    executable-at: (+ (var-get pending-swap-vault-height) SWAP_VAULT_COOLDOWN),
  }
)

(define-private (assert-active-vault (vault <swap-vault-interface>))
  (ok (asserts! (is-eq (contract-of vault) (var-get swap-vault))
    ERR_INVALID_SWAP_VAULT
  ))
)

(define-private (assert-idle-vault (vault <swap-vault-interface>))
  (let ((status (try! (contract-call? vault get-upgrade-status))))
    (asserts! (is-eq (get pool status) current-contract) ERR_INVALID_SWAP_VAULT)
    (asserts!
      (and
        (is-none (get batch-start status))
        (is-eq (get jing-resting status) u0)
        (is-eq (get jing-parked status) u0)
      )
      ERR_SWAP_VAULT_BUSY
    )
    (ok true)
  )
)

(define-public (propose-swap-vault (new-vault <swap-vault-interface>))
  (begin
    (try! (authorize-admin))
    (asserts! (not (is-eq (contract-of new-vault) (var-get swap-vault)))
      ERR_INVALID_SWAP_VAULT
    )
    (try! (assert-idle-vault new-vault))
    (var-set pending-swap-vault (some (contract-of new-vault)))
    (var-set pending-swap-vault-height burn-block-height)
    (print {
      topic: "propose-swap-vault",
      current: (var-get swap-vault),
      proposed: (contract-of new-vault),
      executable-at: (+ burn-block-height SWAP_VAULT_COOLDOWN),
    })
    (ok (contract-of new-vault))
  )
)

(define-public (cancel-swap-vault-proposal)
  (begin
    (try! (authorize-admin))
    (print {
      topic: "cancel-swap-vault-proposal",
      cancelled: (var-get pending-swap-vault),
    })
    (var-set pending-swap-vault none)
    (var-set pending-swap-vault-height u0)
    (ok true)
  )
)

(define-public (confirm-swap-vault
    (old-vault <swap-vault-interface>)
    (new-vault <swap-vault-interface>)
  )
  (begin
    (try! (authorize-admin))
    (let ((proposed (unwrap! (var-get pending-swap-vault) ERR_NO_PENDING_SWAP_VAULT)))
      (try! (assert-active-vault old-vault))
      (asserts! (is-eq (contract-of new-vault) proposed) ERR_INVALID_SWAP_VAULT)
      (asserts!
        (>= burn-block-height
          (+ (var-get pending-swap-vault-height) SWAP_VAULT_COOLDOWN)
        )
        ERR_SWAP_VAULT_COOLDOWN
      )
      (asserts! (is-none (var-get vault-cycle)) ERR_VAULT_BUSY)
      (try! (assert-idle-vault old-vault))
      (try! (assert-idle-vault new-vault))
      (var-set swap-vault proposed)
      (var-set pending-swap-vault none)
      (var-set pending-swap-vault-height u0)
      (print {
        topic: "confirm-swap-vault",
        old-vault: (contract-of old-vault),
        new-vault: proposed,
      })
      (ok proposed)
    )
  )
)

(define-data-var vault-cycle (optional uint) none)

(define-map recovered-sbtc-by-cycle
  uint
  uint
)

(define-public (fund-swap-vault
    (reward-cycle uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (asserts! (is-none (var-get vault-cycle)) ERR_VAULT_BUSY)
    (try! (pin-shares reward-cycle))
    (let (
        (settlement (get-settlement reward-cycle))
        (unfunded-sats (- (get pot-sats settlement) (get swapped-sats settlement)))
        (fee (/ (* unfunded-sats (get-fee-bips-for-cycle reward-cycle)) MAX_BIPS))
        (vault-sats (- unfunded-sats fee))
      )
      (asserts! (> vault-sats u0) ERR_ZERO_VAULT_FUNDING)
      (try! (as-contract?
        ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          "sbtc-token" vault-sats
        ))
        (try! (contract-call? vault fund vault-sats))
      ))
      (var-set earned-fees (+ (var-get earned-fees) fee))
      (var-set unswapped-sats (- (var-get unswapped-sats) unfunded-sats))
      (map-set cycle-settlement reward-cycle
        (merge settlement {
          swapped-sats: (+ (get swapped-sats settlement) unfunded-sats),
          fee-sats: (+ (get fee-sats settlement) fee),
        })
      )
      (var-set vault-cycle (some reward-cycle))
      (ok vault-sats)
    )
  )
)

(define-public (finalize-swap-vault (vault <swap-vault-interface>))
  (begin
    (try! (assert-active-vault vault))
    (let (
        (reward-cycle (unwrap! (var-get vault-cycle) ERR_NO_ACTIVE_VAULT))
        (before (stx-get-balance current-contract))
        (amount (try! (contract-call? vault finish)))
        (settlement (get-settlement reward-cycle))
      )
      (asserts! (is-eq (- (stx-get-balance current-contract) before) amount)
        ERR_VAULT_BUSY
      )
      (map-set cycle-settlement reward-cycle
        (merge settlement { stx-out: (+ (get stx-out settlement) amount) })
      )
      (var-set unpaid-stx (+ (var-get unpaid-stx) amount))
      (var-set vault-cycle none)
      (ok amount)
    )
  )
)

(define-public (recover-swap-vault (vault <swap-vault-interface>))
  (begin
    (try! (assert-active-vault vault))
    (let (
        (reward-cycle (unwrap! (var-get vault-cycle) ERR_NO_ACTIVE_VAULT))
        (settlement (get-settlement reward-cycle))
      )
      (asserts! (> burn-block-height (get deadline settlement))
        ERR_RECOVERY_TOO_SOON
      )
      (let ((recovered (try! (contract-call? vault emergency-recover))))
        (map-set cycle-settlement reward-cycle
          (merge settlement { stx-out: (+ (get stx-out settlement) (get stx recovered)) })
        )
        (map-set recovered-sbtc-by-cycle reward-cycle
          (+ (default-to u0 (map-get? recovered-sbtc-by-cycle reward-cycle))
            (get sbtc recovered)
          ))
        (var-set unpaid-stx (+ (var-get unpaid-stx) (get stx recovered)))
        (var-set unswapped-sats (+ (var-get unswapped-sats) (get sbtc recovered)))
        (var-set vault-cycle none)
        (print {
          topic: "recover-swap-vault",
          reward-cycle: reward-cycle,
          recovered: recovered,
        })
        (ok recovered)
      )
    )
  )
)

(define-public (refloor-vault
    (update (buff 8192))
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (try! (authorize-admin))
    (contract-call? vault jing-refloor update)
  )
)

(define-read-only (get-vault-cycle)
  (var-get vault-cycle)
)

(define-public (set-vault-window-blocks
    (blocks uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (try! (authorize-admin))
    (contract-call? vault set-window-blocks blocks)
  )
)

(define-public (set-vault-leeway-bps
    (bps uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (try! (authorize-admin))
    (contract-call? vault set-leeway-bps bps)
  )
)

(define-public (set-vault-slippage-bps
    (bps uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (try! (authorize-admin))
    (contract-call? vault set-slippage-bps bps)
  )
)

(define-public (set-vault-max-chunk-sats
    (sats uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (try! (authorize-admin))
    (contract-call? vault set-max-chunk-sats sats)
  )
)

(define-public (set-vault-dia-band-bps
    (bps uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (try! (authorize-admin))
    (contract-call? vault set-dia-band-bps bps)
  )
)

(define-public (set-vault-router-cooldown
    (blocks uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (try! (authorize-admin))
    (contract-call? vault set-router-cooldown blocks)
  )
)

(define-public (set-vault-pyth-fee-budget
    (ustx uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (try! (authorize-admin))
    (contract-call? vault set-pyth-fee-budget ustx)
  )
)

(define-public (jing-take
    (amount uint)
    (update (buff 8192))
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (try! (authorize-admin))
    (contract-call? vault jing-take amount update)
  )
)

(define-public (router-swap-split
    (amount uint)
    (jing uint)
    (dlmm uint)
    (xyk uint)
    (velar uint)
    (update (buff 8192))
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (try! (authorize-admin))
    (contract-call? vault router-swap-split amount jing dlmm xyk velar
      update
    )
  )
)

(define-public (set-vault-no-pyth-slippage-bps
    (bps uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (try! (authorize-admin))
    (contract-call? vault set-no-pyth-slippage-bps bps)
  )
)

(define-public (router-swap-split-dia
    (amount uint)
    (dlmm uint)
    (xyk uint)
    (velar uint)
    (vault <swap-vault-interface>)
  )
  (begin
    (try! (assert-active-vault vault))
    (try! (authorize-admin))
    (contract-call? vault router-swap-split-dia amount dlmm xyk velar)
  )
)

;;; ---------------------------------------------------------------------------
;;; 4. Distribute
;;; ---------------------------------------------------------------------------

;; Unsold sBTC recovered after both the signer and vault delays have elapsed.
(define-read-only (get-unswapped-for-cycle (reward-cycle uint))
  (default-to u0 (map-get? recovered-sbtc-by-cycle reward-cycle))
)

;; Both payout legs for one stacker.
;;
;; There is no branch: every stacker gets both, and one of them is almost
;; always zero. A fully swapped cycle pays only STX; a timed-out cycle pays
;; only sBTC; a partially swapped cycle that then timed out pays both, in the
;; same proportion for everyone.
;;
;; The vault was funded net of fees, so recovered sBTC is already net and is
;; not charged again during distribution.
(define-private (compute-due
    (stacker principal)
    (reward-cycle uint)
    (stx-out uint)
    (unswapped uint)
    (total-shares uint)
    (fee-bips uint)
  )
  (let (
      (shares (default-to u0
        (map-get? mirrored-shares {
          stacker: stacker,
          reward-cycle: reward-cycle,
        })
      ))
      (stx-paid (default-to u0
        (map-get? stacker-stx-paid {
          stacker: stacker,
          reward-cycle: reward-cycle,
        })
      ))
      (sbtc-accounted (default-to u0
        (map-get? stacker-sbtc-accounted {
          stacker: stacker,
          reward-cycle: reward-cycle,
        })
      ))
      ;; Floor division; the remainder stays in the contract as dust.
      (stx-entitled (if (is-eq total-shares u0)
        u0
        (/ (* stx-out shares) total-shares)
      ))
      (sbtc-entitled (if (is-eq total-shares u0)
        u0
        (/ (* unswapped shares) total-shares)
      ))
      (sbtc-gross-due (if (> sbtc-entitled sbtc-accounted)
        (- sbtc-entitled sbtc-accounted)
        u0
      ))
      (sbtc-fee (/ (* sbtc-gross-due fee-bips) MAX_BIPS))
    )
    {
      shares: shares,
      stx-entitled: stx-entitled,
      stx-paid: stx-paid,
      stx-due: (if (> stx-entitled stx-paid)
        (- stx-entitled stx-paid)
        u0
      ),
      sbtc-entitled: sbtc-entitled,
      sbtc-accounted: sbtc-accounted,
      sbtc-gross-due: sbtc-gross-due,
      sbtc-fee: sbtc-fee,
      sbtc-due: (- sbtc-gross-due sbtc-fee),
    }
  )
)

;; Read-only view of what a stacker is owed for a cycle. Everything reads zero
;; until the cycle's shares are pinned, which is honest: nothing is payable
;; before the denominator is known.
(define-read-only (get-stacker-rewards
    (stacker principal)
    (reward-cycle uint)
  )
  (let ((settlement (get-settlement reward-cycle)))
    (compute-due stacker reward-cycle (get stx-out settlement)
      (get-unswapped-for-cycle reward-cycle) (get total-shares settlement) u0
    )
  )
)

;; Pay one stacker both legs and advance both watermarks.
(define-private (pay-stacker
    (stacker principal)
    (reward-cycle uint)
    (due {
      shares: uint,
      stx-entitled: uint,
      stx-paid: uint,
      stx-due: uint,
      sbtc-entitled: uint,
      sbtc-accounted: uint,
      sbtc-gross-due: uint,
      sbtc-fee: uint,
      sbtc-due: uint,
    })
  )
  (let (
      (stx-due (get stx-due due))
      (sbtc-due (get sbtc-due due))
    )
    (if (> stx-due u0)
      (begin
        (map-set stacker-stx-paid {
          stacker: stacker,
          reward-cycle: reward-cycle,
        }
          (get stx-entitled due)
        )
        (var-set unpaid-stx (- (var-get unpaid-stx) stx-due))
        (try! (as-contract?
          ((with-stx stx-due))
          (try! (stx-transfer? stx-due tx-sender stacker))
        ))
      )
      true
    )
    (if (> (get sbtc-gross-due due) u0)
      (begin
        (map-set stacker-sbtc-accounted {
          stacker: stacker,
          reward-cycle: reward-cycle,
        }
          (get sbtc-entitled due)
        )
        ;; The whole gross leaves the reserve: the stacker's share as sBTC and
        ;; the pool's cut into `earned-fees`.
        (var-set unswapped-sats (- (var-get unswapped-sats) (get sbtc-gross-due due)))
        (var-set earned-fees (+ (var-get earned-fees) (get sbtc-fee due)))
        (if (> sbtc-due u0)
          (try! (as-contract?
            ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
              "sbtc-token" sbtc-due
            ))
            (try! (contract-call?
              'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer
              sbtc-due tx-sender stacker none
            ))
          ))
          true
        )
      )
      true
    )
    (print {
      topic: "distribute-rewards",
      stacker: stacker,
      reward-cycle: reward-cycle,
      stx: stx-due,
      sbtc: sbtc-due,
      sbtc-fee: (get sbtc-fee due),
    })
    (ok true)
  )
)

;; Pay one stacker. Permissionless -- anyone may trigger a payout on a
;; stacker's behalf.
(define-public (distribute-rewards
    (stacker principal)
    (reward-cycle uint)
  )
  (begin
    (try! (pin-shares reward-cycle))
    (let ((due (get-stacker-rewards stacker reward-cycle)))
      (asserts!
        (or (> (get stx-due due) u0) (> (get sbtc-gross-due due) u0))
        ERR_NOTHING_TO_DISTRIBUTE
      )
      (try! (pay-stacker stacker reward-cycle due))
      (ok {
        stx: (get stx-due due),
        sbtc: (get sbtc-due due),
      })
    )
  )
)

(define-private (fold-distribute
    (stacker principal)
    (acc (response {
      reward-cycle: uint,
      stx-out: uint,
      unswapped: uint,
      total-shares: uint,
      fee-bips: uint,
      paid-count: uint,
      total-stx: uint,
      total-sbtc: uint,
    }
      uint
    ))
  )
  (let (
      (state (try! acc))
      (reward-cycle (get reward-cycle state))
      (due (compute-due stacker reward-cycle (get stx-out state)
        (get unswapped state) (get total-shares state) (get fee-bips state)
      ))
    )
    ;; A stacker with nothing payable is skipped, never an error: one stacker
    ;; must not be able to block a batch.
    (if (and (is-eq (get stx-due due) u0) (is-eq (get sbtc-gross-due due) u0))
      (ok state)
      (begin
        (try! (pay-stacker stacker reward-cycle due))
        (ok (merge state {
          paid-count: (+ (get paid-count state) u1),
          total-stx: (+ (get total-stx state) (get stx-due due)),
          total-sbtc: (+ (get total-sbtc state) (get sbtc-due due)),
        }))
      )
    )
  )
)

;; Pay many stackers in one transaction.
;;
;; The settlement figures are read once and carried in the accumulator rather
;; than re-read per stacker: nothing in this function changes them. The
;; distribution path makes no pox-5 calls at all, so the binding cost here is
;; the transfers themselves.
(define-public (distribute-rewards-many
    (stackers (list 300 principal))
    (reward-cycle uint)
  )
  (begin
    (try! (pin-shares reward-cycle))
    (let (
        (settlement (get-settlement reward-cycle))
        (summary (try! (fold fold-distribute stackers
          (ok {
            reward-cycle: reward-cycle,
            stx-out: (get stx-out settlement),
            unswapped: (get-unswapped-for-cycle reward-cycle),
            total-shares: (get total-shares settlement),
            ;; The vault was funded net of fees, so recovered sBTC is already net.
            fee-bips: u0,
            paid-count: u0,
            total-stx: u0,
            total-sbtc: u0,
          })
        )))
      )
      (print {
        topic: "distribute-rewards-many",
        reward-cycle: reward-cycle,
        paid: (get paid-count summary),
        total-stx: (get total-stx summary),
        total-sbtc: (get total-sbtc summary),
      })
      (ok {
        paid: (get paid-count summary),
        total-stx: (get total-stx summary),
        total-sbtc: (get total-sbtc summary),
      })
    )
  )
)

;;; ---------------------------------------------------------------------------
;;; Admin
;;; ---------------------------------------------------------------------------

(define-public (update-admin
    (admin principal)
    (enabled bool)
  )
  (begin
    (try! (authorize-admin))
    (asserts! (not (is-eq tx-sender admin)) ERR_UNAUTHORIZED_ADMIN)
    (print {
      topic: "update-admin",
      admin: admin,
      enabled: enabled,
    })
    (ok (map-set admins admin enabled))
  )
)
(define-public (update-fees (new-fees uint))
  (begin
    (try! (authorize-admin))
    (asserts! (< new-fees MAX_BIPS) ERR_INVALID_FEES_BIPS)
    (print {
      topic: "update-fees",
      old-fees: (var-get fees-bips),
      new-fees: new-fees,
    })
    (ok (var-set fees-bips new-fees))
  )
)
(define-public (withdraw-fees
    (amount uint)
    (recipient principal)
  )
  (let ((fees (var-get earned-fees)))
    (try! (authorize-admin))
    (asserts! (<= amount fees) ERR_INSUFFICIENT_FEES)
    (var-set earned-fees (- fees amount))
    (try! (as-contract?
      ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token"
        amount
      ))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer amount tx-sender recipient none
      ))
    ))
    (print {
      topic: "withdraw-fees",
      amount-sats: amount,
      recipient: recipient,
    })
    (ok amount)
  )
)

;; Sweep sBTC that is owed to nobody: the balance less accrued fees and less
;; the pot still awaiting a swap or a timeout payout. Subtracting both
;; liabilities is what makes it impossible for an admin to reach stacker funds.
;;
;; What this recovers is sBTC that arrived outside the reward path -- a stray
;; transfer to this contract, say. It deliberately does NOT recover the
;; floor-division remainder of a timeout payout: `unswapped-sats` is reduced by
;; each stacker's floored gross, so the remainder stays inside the liability
;; and is never sweepable. That is the conservative side of the trade -- an
;; admin can never reach a stacker -- at the cost of stranding under one
;; satoshi per stacker per cycle in the contract forever.
(define-public (sweep-sbtc-dust (recipient principal))
  (let (
      (balance (unwrap-panic (contract-call?
        'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance
        current-contract
      )))
      (reserved (+ (var-get earned-fees) (var-get unswapped-sats)))
      (sweepable (if (>= balance reserved)
        (- balance reserved)
        u0
      ))
    )
    (try! (authorize-admin))
    (asserts! (> sweepable u0) ERR_NO_DUST)
    (try! (as-contract?
      ((with-ft 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token"
        sweepable
      ))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer sweepable tx-sender recipient none
      ))
    ))
    (print {
      topic: "sweep-sbtc-dust",
      amount-sats: sweepable,
      recipient: recipient,
    })
    (ok sweepable)
  )
)

;; Sweep STX that is owed to nobody: the balance less what swaps have credited
;; and distributions have not yet paid out.
;;
;; As with `sweep-sbtc-dust`, this recovers STX that arrived outside the reward
;; path, not the floor-division remainder of a pro-rata split -- `unpaid-stx`
;; is reduced only by what each stacker is actually paid, so the remainder
;; stays reserved and unreachable. Under one micro-STX per stacker per cycle is
;; stranded that way, which is the price of the guarantee that no admin call
;; can ever touch stacker funds.
;;
;; This contract never locks STX (stackers lock their own against it), so
;; `stx-get-balance` needs no adjustment for a locked portion.
(define-public (sweep-stx-dust (recipient principal))
  (let (
      (balance (stx-get-balance current-contract))
      (reserved (var-get unpaid-stx))
      (sweepable (if (>= balance reserved)
        (- balance reserved)
        u0
      ))
    )
    (try! (authorize-admin))
    (asserts! (> sweepable u0) ERR_NO_DUST)
    (try! (as-contract?
      ((with-stx sweepable))
      (try! (stx-transfer? sweepable tx-sender recipient))
    ))
    (print {
      topic: "sweep-stx-dust",
      amount-ustx: sweepable,
      recipient: recipient,
    })
    (ok sweepable)
  )
)

;; Register this contract with pox-5 under a signer key. The key grant must not
;; have been used yet.
(define-public (register-self
    (signer-manager <signer-manager-trait>)
    (signer-key (buff 33))
    (auth-id uint)
    (signer-sig (buff 65))
  )
  (begin
    (try! (authorize-admin))
    (try! (contract-call? 'SP000000000000000000002Q6VF78.pox-5 grant-signer-key
      signer-key current-contract auth-id signer-sig
    ))
    (contract-call? 'SP000000000000000000002Q6VF78.pox-5 register-signer
      signer-manager signer-key
    )
  )
)

;;; ---------------------------------------------------------------------------
;;; Authorization
;;; ---------------------------------------------------------------------------

(define-private (authorize-admin)
  (ok (asserts! (and (is-eq contract-caller tx-sender) (is-admin tx-sender))
    ERR_UNAUTHORIZED_ADMIN
  ))
)
;; `validate-stake!` writes per-stacker state keyed by its `stacker` argument;
;; if anyone could invoke it directly they could mint themselves shares.
(define-private (authorize-pox-5)
  (ok (asserts! (is-eq contract-caller 'SP000000000000000000002Q6VF78.pox-5)
    ERR_UNAUTHORIZED_CALLER
  ))
)

;;; ---------------------------------------------------------------------------
;;; Read-only views
;;; ---------------------------------------------------------------------------

(define-read-only (get-settlement (reward-cycle uint))
  (default-to EMPTY_SETTLEMENT (map-get? cycle-settlement reward-cycle))
)

(define-read-only (is-pinned (reward-cycle uint))
  (get pinned (get-settlement reward-cycle))
)

(define-read-only (get-swap-status (reward-cycle uint))
  (let ((settlement (get-settlement reward-cycle)))
    (merge settlement {
      remaining-sats: (- (get pot-sats settlement) (get swapped-sats settlement)),
      window-open: (and
        (> (get deadline settlement) u0)
        (<= burn-block-height (get deadline settlement))
      ),
      recovered-sats: (get-unswapped-for-cycle reward-cycle),
      in-vault: (is-eq (var-get vault-cycle) (some reward-cycle)),
    })
  )
)

;; The mirror against pox-5's own signer total, for the keeper to check before
;; spending a `pin-shares` transaction.
(define-read-only (check-mirror (reward-cycle uint))
  (let (
      (local (default-to u0 (map-get? mirrored-total-shares reward-cycle)))
      (remote (contract-call? 'SP000000000000000000002Q6VF78.pox-5
        get-signer-pending-staked-ustx-per-cycle current-contract reward-cycle
      ))
    )
    {
      local: local,
      pox-5: remote,
      matches: (is-eq local remote),
    }
  )
)

(define-read-only (get-mirrored-shares
    (stacker principal)
    (reward-cycle uint)
  )
  (default-to u0
    (map-get? mirrored-shares {
      stacker: stacker,
      reward-cycle: reward-cycle,
    })
  )
)

(define-read-only (get-mirrored-total-shares (reward-cycle uint))
  (default-to u0 (map-get? mirrored-total-shares reward-cycle))
)

(define-read-only (get-fee-bips-for-cycle (reward-cycle uint))
  (default-to (var-get fees-bips) (map-get? fee-bips-for-cycle reward-cycle))
)
(define-read-only (is-admin (caller principal))
  (default-to false (map-get? admins caller))
)
(define-read-only (get-fees-bips)
  (var-get fees-bips)
)

(define-read-only (get-earned-fees)
  (var-get earned-fees)
)

(define-read-only (get-unswapped-sats)
  (var-get unswapped-sats)
)

(define-read-only (get-unpaid-stx)
  (var-get unpaid-stx)
)
