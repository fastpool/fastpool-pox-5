;; title: signer-manager-vault-stx-rewards
;; A FAST Pool signer manager for pox-5 that pays stacking rewards in STX, with
;; the sBTC -> STX conversion delegated to a dedicated, upgradeable swap vault.
;;
;; pox-5 pays a pool's rewards in sBTC. This contract claims that pot, hands the
;; net of fees to a swap vault that sells it for STX over a bounded window, and
;; distributes the STX to its stakers pro-rata. Everyone locked against this
;; contract receives STX at the same execution price.
;;
;; A cycle moves through these steps, every one of them permissionless:
;;
;;   1. claim-rewards        pox-5 -> here. Opens a 3-day funding window.
;;   2. pin-shares           freeze the pro-rata denominator.
;;   3. fund-swap-vault      send the cycle's net sBTC to the active vault.
;;   4. finalize-swap-vault  the vault sold everything: book the STX it returns.
;;      recover-swap-vault   the vault ran out of time: book whatever STX and
;;                           sBTC it returns.
;;   5. distribute-*         pay stakers.
;;
;; Nothing a privileged key does -- or fails to do -- can strand staker funds:
;;
;;   * sBTC that never reached a vault (the vault was busy, the mirror was
;;     drifted, nobody called `fund-swap-vault`) is released as sBTC once the
;;     funding window closes. See `release-unfunded`.
;;   * sBTC a vault could not sell comes back through `recover-swap-vault`, which
;;     anyone may call once the vault's own recovery delay has passed.
;;   * Every asset coming back from a vault is credited from this contract's own
;;     balance deltas, never from what the vault reports.
;;   * A vault can be replaced while it still holds a batch, so a broken vault
;;     never blocks the pool from moving on; its batch stays recoverable.
;;
;; STX stacking only. Bond stacking and pox-addr calldata are both refused in
;; `validate-stake!`.
;;
;; Trust model. Admins choose the vault (behind a SWAP_VAULT_COOLDOWN notice
;; period stakers can react to) and tune it within the bounds below, which are
;; tighter than the vault's own. The operator -- a hot key -- may only trigger
;; vault trades, which the vault prices against its oracles.
;;
;; See docs/plan-fastpool-stx-rewards.md for the share-mirror design rationale.

(impl-trait 'ST000000000000000000002AMW42H.pox-5.signer-manager-trait)
(use-trait signer-manager-trait 'ST000000000000000000002AMW42H.pox-5.signer-manager-trait)
(use-trait swap-vault-trait 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.juice-swap-vault-trait-v2.swap-vault-trait)

;;; Errors
;;
;; Codes u1001-u1033 mean the same as in `fastpool-stx-rewards-signer-manager`.
;; Codes this contract adds start at u1040.

;; A staker had nothing payable for this cycle.
(define-constant ERR_NO_CLAIMABLE_REWARDS (err u1001))
;; Attempted an admin-only function.
(define-constant ERR_UNAUTHORIZED_ADMIN (err u1002))
;; Staking calldata (a pox-addr for L1 payouts) is not supported here.
(define-constant ERR_CALLDATA_NOT_SUPPORTED (err u1003))
;; Fee rate is not a valid basis-point value.
(define-constant ERR_INVALID_FEES_BIPS (err u1005))
;; A pox-5 callback (`validate-stake!`) was invoked by a principal other than
;; the pox-5 contract.
(define-constant ERR_UNAUTHORIZED_CALLER (err u1006))
;; Tried to withdraw more fees than have accrued.
(define-constant ERR_INSUFFICIENT_FEES (err u1007))
;; Attempted an operator-only function (the vault trade entry points).
(define-constant ERR_UNAUTHORIZED_OPERATOR (err u1020))
;; Bond staking is not supported by this signer manager.
(define-constant ERR_BONDS_NOT_SUPPORTED (err u1021))
;; pox-5 asked to mirror more cycles than a lock can cover.
(define-constant ERR_INVALID_LOCK_PERIOD (err u1022))
;; `claim-rewards` has not run for this cycle, so there is nothing to settle.
(define-constant ERR_CYCLE_NOT_CLAIMED (err u1023))
;; The local share mirror disagrees with pox-5's signer total. Repairable --
;; see `repair-mirror-many`.
(define-constant ERR_SHARE_MIRROR_MISMATCH (err u1024))
;; The cycle's shares are already pinned and can no longer be changed.
(define-constant ERR_SHARES_ALREADY_PINNED (err u1025))
;; The cycle's funding window has closed; its sBTC is paid out as sBTC.
(define-constant ERR_SWAP_WINDOW_CLOSED (err u1026))
;; There is no sweepable dust.
(define-constant ERR_NO_DUST (err u1033))

;; The vault passed is not the active vault.
(define-constant ERR_NOT_ACTIVE_VAULT (err u1040))
;; The active vault is still working a batch.
(define-constant ERR_VAULT_BUSY (err u1041))
;; The cycle has no sBTC left to send to a vault.
(define-constant ERR_NOTHING_TO_FUND (err u1042))
;; The vault passed holds no batch from this contract.
(define-constant ERR_NO_VAULT_BATCH (err u1043))
;; The vault took a different amount of sBTC than it was funded with.
(define-constant ERR_VAULT_FUNDING_MISMATCH (err u1044))
;; The proposed vault is not bound to this contract, or is the active one.
(define-constant ERR_INVALID_SWAP_VAULT (err u1045))
;; The proposed vault is not idle.
(define-constant ERR_SWAP_VAULT_NOT_IDLE (err u1046))
;; There is no vault proposal to confirm, or it is for a different vault.
(define-constant ERR_NO_PENDING_SWAP_VAULT (err u1047))
;; The vault proposal's notice period has not elapsed.
(define-constant ERR_SWAP_VAULT_COOLDOWN (err u1048))
;; A vault setting is outside the bounds this contract allows.
(define-constant ERR_VAULT_PARAM_OUT_OF_RANGE (err u1049))

;;; Constants

;; Highest fee an admin may set, in basis points (inclusive): 5%.
(define-constant MAX_FEE_BIPS u500)
(define-constant BIPS_DENOMINATOR u10000)
;; A fee *increase* only becomes snapshottable this many reward cycles after it
;; is queued, so stakers can unstake before it applies to them.
(define-constant FEE_ACTIVATION_DELAY_CYCLES u2)
;; How long after a cycle's first claim its sBTC may still be sent to a vault.
;; Past it, whatever was not funded is released to stakers as sBTC. ~3 days.
(define-constant SWAP_WINDOW_BURN_BLOCKS u432)
;; Notice period between proposing a new vault and switching to it. ~4 weeks:
;; longer than a reward cycle, so a staker who distrusts the new vault can
;; unstake before any of their rewards reach it.
(define-constant SWAP_VAULT_COOLDOWN u4032)

;; Bounds on vault settings, tighter than the vault's own. They cap how far
;; below its oracle mid an admin can make the vault sell.
;;   slippage-bps          floor below the Pyth mid for taker/router sells
;;   leeway-bps            maker ask below the Pyth mid
;;   no-pyth-slippage-bps  floor below the DIA mid when Pyth is unavailable
;;   dia-band-bps          allowed Pyth/DIA divergence; 0 would switch the
;;                         cross-check off, so it is refused
(define-constant MAX_VAULT_SLIPPAGE_BPS u300)
(define-constant MAX_VAULT_LEEWAY_BPS u500)
(define-constant MAX_VAULT_NO_PYTH_SLIPPAGE_BPS u1000)
(define-constant MIN_VAULT_DIA_BAND_BPS u1)
(define-constant MAX_VAULT_DIA_BAND_BPS u1000)

(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)

;; Offsets used to walk the cycles a stake covers. MUST be at least as long as
;; pox-5's `MAX_NUM_CYCLES` (u96), or a legal stake is refused.
(define-constant CYCLE_OFFSETS (list
  u0 u1 u2 u3 u4 u5 u6 u7 u8 u9 u10 u11 u12 u13 u14 u15 u16 u17 u18 u19 u20
  u21 u22 u23 u24 u25 u26 u27 u28 u29 u30 u31 u32 u33 u34 u35 u36 u37 u38
  u39 u40 u41 u42 u43 u44 u45 u46 u47 u48 u49 u50 u51 u52 u53 u54 u55 u56
  u57 u58 u59 u60 u61 u62 u63 u64 u65 u66 u67 u68 u69 u70 u71 u72 u73 u74
  u75 u76 u77 u78 u79 u80 u81 u82 u83 u84 u85 u86 u87 u88 u89 u90 u91 u92
  u93 u94 u95
))

;;; Roles

;; Admins set fees, choose and configure the vault, withdraw fees, sweep dust
;; and set the operator. Deployer is seeded as the first admin.
(define-map admins
  principal
  bool
)
(map-set admins tx-sender true)

;; The operator may trigger vault trades and nothing else.
(define-data-var operator principal tx-sender)

;;; Fees
;;
;; Always taken in sBTC: on the funded portion when it is sent to the vault, on
;; an unfunded remainder when it is released.

(define-data-var fees-bips uint u0)
(define-data-var pending-fees-bips uint u0)
(define-data-var pending-fees-cycle uint u0)
(define-data-var earned-fees uint u0)
;; The rate in force when a cycle was first claimed.
(define-map fee-bips-for-cycle
  uint
  uint
)

;;; Reserves
;;
;; Each asset gets an explicit liability counter so an admin sweep can never
;; reach staker funds.

;; sBTC held for stakers: pots not yet funded or released, plus sBTC that has
;; been released or recovered and not yet paid out.
(define-data-var unswapped-sats uint u0)
;; Micro-STX booked from vaults and not yet paid to a staker.
(define-data-var unpaid-stx uint u0)

;;; Share mirror -- see `fastpool-stx-rewards-signer-manager` for the design.

(define-map mirrored-shares
  {
    staker: principal,
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
    ;; gross sBTC pulled in from pox-5
    pot-sats: uint,
    ;; of `pot-sats`, how much was sent to a vault (fee included)
    funded-sats: uint,
    ;; of `pot-sats`, how much was released unfunded (fee included)
    released-sats: uint,
    ;; fees taken on funded + released
    fee-sats: uint,
    ;; net sats currently sitting in a vault batch for this cycle
    in-vault-sats: uint,
    ;; micro-STX booked from vaults, payable pro-rata
    stx-out: uint,
    ;; net sats released or recovered, payable pro-rata
    sbtc-out: uint,
    ;; the pinned pro-rata denominator
    total-shares: uint,
    ;; last burn height at which `fund-swap-vault` is accepted
    deadline: uint,
    pinned: bool,
  }
)

(define-constant EMPTY_SETTLEMENT {
  pot-sats: u0,
  funded-sats: u0,
  released-sats: u0,
  fee-sats: u0,
  in-vault-sats: u0,
  stx-out: u0,
  sbtc-out: u0,
  total-shares: u0,
  deadline: u0,
  pinned: false,
})

;;; Payout watermarks -- monotone, so repeated distributions pay the difference.

(define-map staker-stx-paid
  {
    staker: principal,
    reward-cycle: uint,
  }
  uint
)

(define-map staker-sbtc-paid
  {
    staker: principal,
    reward-cycle: uint,
  }
  uint
)

;;; Swap vaults

;; The vault new batches are sent to. Its own POOL constant must name this
;; contract; `assert-idle-vault` checks that before it can be adopted.
(define-data-var swap-vault principal .fastpool-swap-vault)
(define-data-var pending-swap-vault (optional principal) none)
(define-data-var pending-swap-vault-height uint u0)

;; Batches handed to a vault and not yet finalized or recovered, keyed by vault.
;; Keyed by vault rather than held in one slot so that a vault replaced while it
;; still holds a batch can be finalized or recovered later. An entry exists
;; only for a contract this one actually funded, which is what authorizes the
;; trait argument of `finalize-swap-vault` / `recover-swap-vault`.
(define-map vault-batches
  principal
  {
    reward-cycle: uint,
    sats: uint,
  }
)

;;; ---------------------------------------------------------------------------
;;; pox-5 callback
;;; ---------------------------------------------------------------------------

(define-public (validate-stake!
    (staker principal)
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
      staker: staker,
      first-reward-cycle: first-index,
      shares: amount-ustx,
    })
    (print {
      topic: "validate-stake",
      staker: staker,
      first-reward-cycle: first-index,
      num-cycles: num-indexes,
      shares: amount-ustx,
      amount-sats: amount-sats,
    })
    (ok true)
  )
)

;;; ---------------------------------------------------------------------------
;;; 1. Claim
;;; ---------------------------------------------------------------------------

;; Pull a cycle's sBTC out of pox-5. Permissionless and repeatable; only the
;; first claim snapshots the fee rate and opens the funding window.
(define-public (claim-rewards (reward-cycle uint))
  (let (
      (result (try! (contract-call? 'ST000000000000000000002AMW42H.pox-5 claim-rewards (list)
        reward-cycle
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
      (map-set fee-bips-for-cycle reward-cycle (get-active-fee-bips))
      true
    )
    (map-set cycle-settlement reward-cycle
      (merge settlement {
        pot-sats: (+ (get pot-sats settlement) earned),
        deadline: deadline,
      })
    )
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

;; Correct the mirror for stakers whose shares pox-5 has since reduced.
(define-public (repair-mirror-many
    (stakers (list 100 principal))
    (reward-cycle uint)
  )
  (begin
    (asserts! (not (is-pinned reward-cycle)) ERR_SHARES_ALREADY_PINNED)
    (let (
        (summary (fold fold-repair-mirror stakers {
          reward-cycle: reward-cycle,
          removed: u0,
          added: u0,
        }))
        (total (default-to u0 (map-get? mirrored-total-shares reward-cycle)))
      )
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

;; Freeze the pro-rata denominator for a cycle against pox-5's own signer
;; total. Permissionless and idempotent.
(define-public (pin-shares (reward-cycle uint))
  (let ((settlement (get-settlement reward-cycle)))
    (asserts! (> (get deadline settlement) u0) ERR_CYCLE_NOT_CLAIMED)
    (if (get pinned settlement)
      (ok (get total-shares settlement))
      (let ((local (default-to u0 (map-get? mirrored-total-shares reward-cycle))))
        (asserts!
          (is-eq local
            (contract-call? 'ST000000000000000000002AMW42H.pox-5
              get-signer-pending-staked-ustx-per-cycle current-contract
              reward-cycle
            ))
          ERR_SHARE_MIRROR_MISMATCH
        )
        (map-set cycle-settlement reward-cycle
          (merge settlement {
            total-shares: local,
            pinned: true,
          })
        )
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

;;; ---------------------------------------------------------------------------
;;; 3. Fund the vault
;;; ---------------------------------------------------------------------------

;; Send everything of a cycle's pot not yet committed, net of fees, to the
;; active vault. Permissionless: the amount is not a choice, and the vault
;; prices every sale against its own oracles.
;;
;; One batch per vault at a time; the vault itself refuses a second `fund`
;; until the first is finished or recovered.
(define-public (fund-swap-vault
    (reward-cycle uint)
    (vault <swap-vault-trait>)
  )
  (let ((vault-principal (contract-of vault)))
    (asserts! (is-eq vault-principal (var-get swap-vault)) ERR_NOT_ACTIVE_VAULT)
    (asserts! (is-none (map-get? vault-batches vault-principal)) ERR_VAULT_BUSY)
    ;; Pin before reading the settlement: pinning writes to it.
    (try! (pin-shares reward-cycle))
    (let (
        (settlement (get-settlement reward-cycle))
        (gross (unfunded-sats settlement))
        (fee (/ (* gross (get-fee-bips-for-cycle reward-cycle)) BIPS_DENOMINATOR))
        (net (- gross fee))
        (sbtc-before (sbtc-balance))
      )
      (asserts! (<= burn-block-height (get deadline settlement))
        ERR_SWAP_WINDOW_CLOSED
      )
      ;; With the fee capped at 5%, `net` is positive whenever `gross` is.
      (asserts! (> net u0) ERR_NOTHING_TO_FUND)
      (try! (as-contract? ((with-ft SBTC "sbtc-token" net))
        (try! (contract-call? vault fund net))
      ))
      ;; The allowance caps what can leave; this catches a vault that took less,
      ;; which would otherwise leave staker sBTC looking like sweepable dust.
      (asserts! (is-eq (- sbtc-before (sbtc-balance)) net)
        ERR_VAULT_FUNDING_MISMATCH
      )
      (var-set earned-fees (+ (var-get earned-fees) fee))
      (var-set unswapped-sats (- (var-get unswapped-sats) gross))
      (map-set cycle-settlement reward-cycle
        (merge settlement {
          funded-sats: (+ (get funded-sats settlement) gross),
          fee-sats: (+ (get fee-sats settlement) fee),
          in-vault-sats: (+ (get in-vault-sats settlement) net),
        })
      )
      (map-set vault-batches vault-principal {
        reward-cycle: reward-cycle,
        sats: net,
      })
      (print {
        topic: "fund-swap-vault",
        reward-cycle: reward-cycle,
        vault: vault-principal,
        gross-sats: gross,
        fee-sats: fee,
        net-sats: net,
      })
      (ok net)
    )
  )
)

;;; ---------------------------------------------------------------------------
;;; 4. Settle the vault batch
;;; ---------------------------------------------------------------------------

;; Book the STX a vault returns once it has sold its whole batch.
;; Permissionless.
(define-public (finalize-swap-vault (vault <swap-vault-trait>))
  (let (
      (vault-principal (contract-of vault))
      (batch (unwrap! (map-get? vault-batches vault-principal) ERR_NO_VAULT_BATCH))
      (stx-before (stx-get-balance current-contract))
      (sbtc-before (sbtc-balance))
      (reported (try! (contract-call? vault finish)))
    )
    (settle-batch vault-principal batch stx-before sbtc-before "finalize-swap-vault"
      reported u0
    )
  )
)

;; Take back whatever a vault still holds -- STX from what it sold, sBTC it
;; could not sell -- once the vault's own recovery delay has passed. The vault
;; enforces that delay. Permissionless, so no privileged key can keep staker
;; funds parked in a vault.
(define-public (recover-swap-vault (vault <swap-vault-trait>))
  (let (
      (vault-principal (contract-of vault))
      (batch (unwrap! (map-get? vault-batches vault-principal) ERR_NO_VAULT_BATCH))
      (stx-before (stx-get-balance current-contract))
      (sbtc-before (sbtc-balance))
      (reported (try! (contract-call? vault emergency-recover)))
    )
    (settle-batch vault-principal batch stx-before sbtc-before "recover-swap-vault"
      (get stx reported) (get sbtc reported)
    )
  )
)

;; Credit what actually arrived -- measured, not reported -- to the batch's
;; cycle, and close the batch.
;;
;; Note on the vault's STX reserve: the vault keeps up to its
;; `pyth-fee-budget` (<= 10 STX) back on `finish` to pay the next batch's oracle
;; fees, and `emergency-recover` returns all of its STX, reserve included. That
;; reserve is therefore carried from one cycle's proceeds into a later cycle's.
(define-private (settle-batch
    (vault principal)
    (batch {
      reward-cycle: uint,
      sats: uint,
    })
    (stx-before uint)
    (sbtc-before uint)
    (topic (string-ascii 24))
    (reported-stx uint)
    (reported-sbtc uint)
  )
  (let (
      (reward-cycle (get reward-cycle batch))
      (stx-after (stx-get-balance current-contract))
      (sbtc-after (sbtc-balance))
      ;; Neither call grants the vault an allowance, so neither balance can
      ;; fall; the guards only keep the arithmetic total.
      (stx-in (if (> stx-after stx-before)
        (- stx-after stx-before)
        u0
      ))
      (sbtc-in (if (> sbtc-after sbtc-before)
        (- sbtc-after sbtc-before)
        u0
      ))
      (settlement (get-settlement reward-cycle))
    )
    (var-set unpaid-stx (+ (var-get unpaid-stx) stx-in))
    (var-set unswapped-sats (+ (var-get unswapped-sats) sbtc-in))
    (map-set cycle-settlement reward-cycle
      (merge settlement {
        in-vault-sats: (- (get in-vault-sats settlement) (get sats batch)),
        stx-out: (+ (get stx-out settlement) stx-in),
        sbtc-out: (+ (get sbtc-out settlement) sbtc-in),
      })
    )
    (map-delete vault-batches vault)
    (print {
      topic: topic,
      reward-cycle: reward-cycle,
      vault: vault,
      batch-sats: (get sats batch),
      stx: stx-in,
      sbtc: sbtc-in,
      reported-stx: reported-stx,
      reported-sbtc: reported-sbtc,
    })
    (ok {
      stx: stx-in,
      sbtc: sbtc-in,
    })
  )
)

;; Once a cycle's funding window has closed, release whatever of its pot never
;; reached a vault so it can be paid out as sBTC. Fees are taken here at the
;; cycle's rate, as they would have been on funding.
;;
;; Permissionless and idempotent, and run implicitly by `distribute-*`. A later
;; claim into an already-closed cycle is released the same way.
(define-public (release-unfunded (reward-cycle uint))
  (let (
      (settlement (get-settlement reward-cycle))
      (gross (unfunded-sats settlement))
    )
    (asserts! (> (get deadline settlement) u0) ERR_CYCLE_NOT_CLAIMED)
    (if (or (<= burn-block-height (get deadline settlement)) (is-eq gross u0))
      (ok u0)
      (let (
          (fee (/ (* gross (get-fee-bips-for-cycle reward-cycle)) BIPS_DENOMINATOR))
          (net (- gross fee))
        )
        ;; The fee moves from the staker liability to the fee liability; the
        ;; net stays inside `unswapped-sats` until it is paid.
        (var-set earned-fees (+ (var-get earned-fees) fee))
        (var-set unswapped-sats (- (var-get unswapped-sats) fee))
        (map-set cycle-settlement reward-cycle
          (merge settlement {
            released-sats: (+ (get released-sats settlement) gross),
            fee-sats: (+ (get fee-sats settlement) fee),
            sbtc-out: (+ (get sbtc-out settlement) net),
          })
        )
        (print {
          topic: "release-unfunded",
          reward-cycle: reward-cycle,
          gross-sats: gross,
          fee-sats: fee,
          net-sats: net,
        })
        (ok net)
      )
    )
  )
)

;;; ---------------------------------------------------------------------------
;;; 5. Distribute
;;; ---------------------------------------------------------------------------

;; Pay one staker. Permissionless.
(define-public (distribute-rewards
    (staker principal)
    (reward-cycle uint)
  )
  (begin
    (try! (pin-shares reward-cycle))
    (try! (release-unfunded reward-cycle))
    (let ((due (get-staker-rewards staker reward-cycle)))
      (asserts! (or (> (get stx-due due) u0) (> (get sbtc-due due) u0))
        ERR_NO_CLAIMABLE_REWARDS
      )
      (try! (pay-staker staker reward-cycle due))
      (ok {
        stx: (get stx-due due),
        sbtc: (get sbtc-due due),
      })
    )
  )
)

;; Pay many stakers in one transaction. Stakers with nothing due are skipped.
(define-public (distribute-rewards-many
    (stakers (list 300 principal))
    (reward-cycle uint)
  )
  (begin
    (try! (pin-shares reward-cycle))
    (try! (release-unfunded reward-cycle))
    (let (
        (settlement (get-settlement reward-cycle))
        (summary (try! (fold fold-distribute stakers
          (ok {
            reward-cycle: reward-cycle,
            stx-out: (get stx-out settlement),
            sbtc-out: (get sbtc-out settlement),
            total-shares: (get total-shares settlement),
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
;;; Vault management (admin)
;;; ---------------------------------------------------------------------------

;; Announce a new vault. It becomes the active vault no earlier than
;; SWAP_VAULT_COOLDOWN burn blocks from now, via `confirm-swap-vault`.
(define-public (propose-swap-vault (new-vault <swap-vault-trait>))
  (begin
    (try! (authorize-admin))
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

;; Switch to the proposed vault. The outgoing vault is not consulted: a batch it
;; still holds stays in `vault-batches` and can be finalized or recovered as
;; before, so a broken vault can always be replaced.
(define-public (confirm-swap-vault (new-vault <swap-vault-trait>))
  (let (
      (proposed (unwrap! (var-get pending-swap-vault) ERR_NO_PENDING_SWAP_VAULT))
      (old-vault (var-get swap-vault))
    )
    (try! (authorize-admin))
    (asserts! (is-eq (contract-of new-vault) proposed) ERR_NO_PENDING_SWAP_VAULT)
    (asserts!
      (>= burn-block-height
        (+ (var-get pending-swap-vault-height) SWAP_VAULT_COOLDOWN)
      )
      ERR_SWAP_VAULT_COOLDOWN
    )
    (try! (assert-idle-vault new-vault))
    (var-set swap-vault proposed)
    (var-set pending-swap-vault none)
    (var-set pending-swap-vault-height u0)
    (print {
      topic: "confirm-swap-vault",
      old-vault: old-vault,
      new-vault: proposed,
    })
    (ok proposed)
  )
)

(define-public (set-vault-window-blocks
    (blocks uint)
    (vault <swap-vault-trait>)
  )
  (begin
    (try! (authorize-admin))
    (try! (assert-active-vault vault))
    (contract-call? vault set-window-blocks blocks)
  )
)

(define-public (set-vault-leeway-bps
    (bps uint)
    (vault <swap-vault-trait>)
  )
  (begin
    (try! (authorize-admin))
    (try! (assert-active-vault vault))
    (asserts! (<= bps MAX_VAULT_LEEWAY_BPS) ERR_VAULT_PARAM_OUT_OF_RANGE)
    (contract-call? vault set-leeway-bps bps)
  )
)

(define-public (set-vault-slippage-bps
    (bps uint)
    (vault <swap-vault-trait>)
  )
  (begin
    (try! (authorize-admin))
    (try! (assert-active-vault vault))
    (asserts! (<= bps MAX_VAULT_SLIPPAGE_BPS) ERR_VAULT_PARAM_OUT_OF_RANGE)
    (contract-call? vault set-slippage-bps bps)
  )
)

(define-public (set-vault-no-pyth-slippage-bps
    (bps uint)
    (vault <swap-vault-trait>)
  )
  (begin
    (try! (authorize-admin))
    (try! (assert-active-vault vault))
    (asserts! (<= bps MAX_VAULT_NO_PYTH_SLIPPAGE_BPS)
      ERR_VAULT_PARAM_OUT_OF_RANGE
    )
    (contract-call? vault set-no-pyth-slippage-bps bps)
  )
)

(define-public (set-vault-dia-band-bps
    (bps uint)
    (vault <swap-vault-trait>)
  )
  (begin
    (try! (authorize-admin))
    (try! (assert-active-vault vault))
    (asserts! (and (>= bps MIN_VAULT_DIA_BAND_BPS) (<= bps MAX_VAULT_DIA_BAND_BPS))
      ERR_VAULT_PARAM_OUT_OF_RANGE
    )
    (contract-call? vault set-dia-band-bps bps)
  )
)

(define-public (set-vault-max-chunk-sats
    (sats uint)
    (vault <swap-vault-trait>)
  )
  (begin
    (try! (authorize-admin))
    (try! (assert-active-vault vault))
    (contract-call? vault set-max-chunk-sats sats)
  )
)

(define-public (set-vault-router-cooldown
    (blocks uint)
    (vault <swap-vault-trait>)
  )
  (begin
    (try! (authorize-admin))
    (try! (assert-active-vault vault))
    (contract-call? vault set-router-cooldown blocks)
  )
)

(define-public (set-vault-pyth-fee-budget
    (ustx uint)
    (vault <swap-vault-trait>)
  )
  (begin
    (try! (authorize-admin))
    (try! (assert-active-vault vault))
    (contract-call? vault set-pyth-fee-budget ustx)
  )
)

(define-public (set-vault-maker-spread-bps
    (bps uint)
    (vault <swap-vault-trait>)
  )
  (begin
    (try! (authorize-admin))
    (try! (assert-active-vault vault))
    (contract-call? vault set-maker-spread-bps bps)
  )
)

;;; ---------------------------------------------------------------------------
;;; Vault trades (operator)
;;; ---------------------------------------------------------------------------
;;
;; Accepted on the active vault and on any vault still holding a batch, so a
;; batch left in a replaced vault can still be sold rather than only recovered.

(define-public (jing-refloor
    (update (buff 8192))
    (vault <swap-vault-trait>)
  )
  (begin
    (try! (authorize-operator))
    (try! (assert-trading-vault vault))
    (contract-call? vault jing-refloor update)
  )
)

(define-public (jing-take
    (amount uint)
    (update (buff 8192))
    (vault <swap-vault-trait>)
  )
  (begin
    (try! (authorize-operator))
    (try! (assert-trading-vault vault))
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
    (vault <swap-vault-trait>)
  )
  (begin
    (try! (authorize-operator))
    (try! (assert-trading-vault vault))
    (contract-call? vault router-swap-split amount jing dlmm xyk velar update)
  )
)

(define-public (router-swap-split-dia
    (amount uint)
    (dlmm uint)
    (xyk uint)
    (velar uint)
    (vault <swap-vault-trait>)
  )
  (begin
    (try! (authorize-operator))
    (try! (assert-trading-vault vault))
    (contract-call? vault router-swap-split-dia amount dlmm xyk velar)
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

(define-public (set-operator (new-operator principal))
  (begin
    (try! (authorize-admin))
    (print {
      topic: "set-operator",
      old: (var-get operator),
      new: new-operator,
    })
    (ok (var-set operator new-operator))
  )
)

;; A decrease applies immediately; an increase is queued for
;; FEE_ACTIVATION_DELAY_CYCLES cycles. Identical to
;; `fastpool-stx-rewards-signer-manager`.
(define-public (update-fees (new-fees uint))
  (let (
      (active (get-active-fee-bips))
      (cycle (current-cycle))
    )
    (try! (authorize-admin))
    (asserts! (<= new-fees MAX_FEE_BIPS) ERR_INVALID_FEES_BIPS)
    (var-set fees-bips active)
    (if (<= new-fees active)
      (begin
        (var-set fees-bips new-fees)
        (var-set pending-fees-bips new-fees)
        (var-set pending-fees-cycle cycle)
      )
      (begin
        (var-set pending-fees-bips new-fees)
        (var-set pending-fees-cycle (+ cycle FEE_ACTIVATION_DELAY_CYCLES))
      )
    )
    (print {
      topic: "update-fees",
      old-fees: active,
      new-fees: new-fees,
      activation-cycle: (var-get pending-fees-cycle),
    })
    (ok true)
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
    (try! (as-contract? ((with-ft SBTC "sbtc-token" amount))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer amount tx-sender recipient none))
    ))
    (print {
      topic: "withdraw-fees",
      amount-sats: amount,
      recipient: recipient,
    })
    (ok amount)
  )
)

;; Sweep sBTC owed to nobody: the balance less accrued fees and less the staker
;; liability. Floor-division remainders stay inside the liability.
(define-public (sweep-sbtc-dust (recipient principal))
  (let (
      (balance (sbtc-balance))
      (reserved (+ (var-get earned-fees) (var-get unswapped-sats)))
      (sweepable (if (>= balance reserved)
        (- balance reserved)
        u0
      ))
    )
    (try! (authorize-admin))
    (asserts! (> sweepable u0) ERR_NO_DUST)
    (try! (as-contract? ((with-ft SBTC "sbtc-token" sweepable))
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer sweepable tx-sender recipient none))
    ))
    (print {
      topic: "sweep-sbtc-dust",
      amount-sats: sweepable,
      recipient: recipient,
    })
    (ok sweepable)
  )
)

;; Sweep STX owed to nobody: the balance less what has been booked and not yet
;; paid.
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
    (try! (as-contract? ((with-stx sweepable))
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

;; Register this contract with pox-5 under a signer key.
(define-public (register-self
    (signer-manager <signer-manager-trait>)
    (signer-key (buff 33))
    (auth-id uint)
    (signer-sig (buff 65))
  )
  (begin
    (try! (authorize-admin))
    (try! (contract-call? 'ST000000000000000000002AMW42H.pox-5 grant-signer-key
      signer-key current-contract auth-id signer-sig
    ))
    (contract-call? 'ST000000000000000000002AMW42H.pox-5 register-signer
      signer-manager signer-key
    )
  )
)

;;; ---------------------------------------------------------------------------
;;; Private helpers
;;; ---------------------------------------------------------------------------

(define-private (authorize-admin)
  (ok (asserts! (and (is-eq contract-caller tx-sender) (is-admin tx-sender))
    ERR_UNAUTHORIZED_ADMIN
  ))
)

(define-private (authorize-operator)
  (ok (asserts!
    (and (is-eq contract-caller tx-sender) (is-eq tx-sender (var-get operator)))
    ERR_UNAUTHORIZED_OPERATOR
  ))
)

(define-private (authorize-pox-5)
  (ok (asserts! (is-eq contract-caller 'ST000000000000000000002AMW42H.pox-5)
    ERR_UNAUTHORIZED_CALLER
  ))
)

(define-private (assert-active-vault (vault <swap-vault-trait>))
  (ok (asserts! (is-eq (contract-of vault) (var-get swap-vault))
    ERR_NOT_ACTIVE_VAULT
  ))
)

(define-private (assert-trading-vault (vault <swap-vault-trait>))
  (ok (asserts!
    (or
      (is-eq (contract-of vault) (var-get swap-vault))
      (is-some (map-get? vault-batches (contract-of vault)))
    )
    ERR_NOT_ACTIVE_VAULT
  ))
)

;; A vault may be adopted only if it is bound to this contract, is not already
;; the active vault, and holds nothing: no open batch on its side, no Jing
;; position, and no batch of ours on this side.
(define-private (assert-idle-vault (vault <swap-vault-trait>))
  (let ((status (try! (contract-call? vault get-upgrade-status))))
    (asserts!
      (and
        (is-eq (get pool status) current-contract)
        (not (is-eq (contract-of vault) (var-get swap-vault)))
      )
      ERR_INVALID_SWAP_VAULT
    )
    (asserts!
      (and
        (is-none (get batch-start status))
        (is-eq (get jing-resting status) u0)
        (is-eq (get jing-parked status) u0)
        (is-none (map-get? vault-batches (contract-of vault)))
      )
      ERR_SWAP_VAULT_NOT_IDLE
    )
    (ok true)
  )
)

(define-read-only (sbtc-balance)
  (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance current-contract))
)

;; The part of a cycle's pot that has been neither funded nor released.
(define-private (unfunded-sats (settlement {
  pot-sats: uint,
  funded-sats: uint,
  released-sats: uint,
  fee-sats: uint,
  in-vault-sats: uint,
  stx-out: uint,
  sbtc-out: uint,
  total-shares: uint,
  deadline: uint,
  pinned: bool,
}))
  (- (get pot-sats settlement)
    (+ (get funded-sats settlement) (get released-sats settlement))
  )
)

(define-private (mirror-stake-for-cycle
    (offset uint)
    (acc {
      staker: principal,
      first-reward-cycle: uint,
      shares: uint,
    })
  )
  (let ((reward-cycle (+ (get first-reward-cycle acc) offset)))
    (if (is-pinned reward-cycle)
      acc
      (let (
          (staker (get staker acc))
          (shares (get shares acc))
          (previous (default-to u0
            (map-get? mirrored-shares {
              staker: staker,
              reward-cycle: reward-cycle,
            })
          ))
          (total (default-to u0 (map-get? mirrored-total-shares reward-cycle)))
        )
        (map-set mirrored-shares {
          staker: staker,
          reward-cycle: reward-cycle,
        }
          shares
        )
        (map-set mirrored-total-shares reward-cycle (+ (- total previous) shares))
        acc
      )
    )
  )
)

(define-private (fold-repair-mirror
    (staker principal)
    (acc {
      reward-cycle: uint,
      removed: uint,
      added: uint,
    })
  )
  (let (
      (reward-cycle (get reward-cycle acc))
      (truth (contract-call? 'ST000000000000000000002AMW42H.pox-5
        get-staker-shares-staked-for-cycle staker reward-cycle none
        current-contract
      ))
      (previous (default-to u0
        (map-get? mirrored-shares {
          staker: staker,
          reward-cycle: reward-cycle,
        })
      ))
    )
    (if (is-eq truth previous)
      acc
      (begin
        (map-set mirrored-shares {
          staker: staker,
          reward-cycle: reward-cycle,
        }
          truth
        )
        (if (> previous truth)
          (merge acc { removed: (+ (get removed acc) (- previous truth)) })
          (merge acc { added: (+ (get added acc) (- truth previous)) })
        )
      )
    )
  )
)

;; Both payout legs for one staker. Both pools are already net of fees.
(define-private (compute-due
    (staker principal)
    (reward-cycle uint)
    (stx-out uint)
    (sbtc-out uint)
    (total-shares uint)
  )
  (let (
      (shares (default-to u0
        (map-get? mirrored-shares {
          staker: staker,
          reward-cycle: reward-cycle,
        })
      ))
      (stx-paid (default-to u0
        (map-get? staker-stx-paid {
          staker: staker,
          reward-cycle: reward-cycle,
        })
      ))
      (sbtc-paid (default-to u0
        (map-get? staker-sbtc-paid {
          staker: staker,
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
        (/ (* sbtc-out shares) total-shares)
      ))
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
      sbtc-paid: sbtc-paid,
      sbtc-due: (if (> sbtc-entitled sbtc-paid)
        (- sbtc-entitled sbtc-paid)
        u0
      ),
    }
  )
)

(define-private (pay-staker
    (staker principal)
    (reward-cycle uint)
    (due {
      shares: uint,
      stx-entitled: uint,
      stx-paid: uint,
      stx-due: uint,
      sbtc-entitled: uint,
      sbtc-paid: uint,
      sbtc-due: uint,
    })
  )
  (let (
      (stx-due (get stx-due due))
      (sbtc-due (get sbtc-due due))
    )
    (if (> stx-due u0)
      (begin
        (map-set staker-stx-paid {
          staker: staker,
          reward-cycle: reward-cycle,
        }
          (get stx-entitled due)
        )
        (var-set unpaid-stx (- (var-get unpaid-stx) stx-due))
        (try! (as-contract? ((with-stx stx-due))
          (try! (stx-transfer? stx-due tx-sender staker))
        ))
      )
      true
    )
    (if (> sbtc-due u0)
      (begin
        (map-set staker-sbtc-paid {
          staker: staker,
          reward-cycle: reward-cycle,
        }
          (get sbtc-entitled due)
        )
        (var-set unswapped-sats (- (var-get unswapped-sats) sbtc-due))
        (try! (as-contract? ((with-ft SBTC "sbtc-token" sbtc-due))
          (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer sbtc-due tx-sender staker none))
        ))
      )
      true
    )
    (print {
      topic: "distribute-rewards",
      staker: staker,
      reward-cycle: reward-cycle,
      stx: stx-due,
      sbtc: sbtc-due,
    })
    (ok true)
  )
)

(define-private (fold-distribute
    (staker principal)
    (acc (response {
      reward-cycle: uint,
      stx-out: uint,
      sbtc-out: uint,
      total-shares: uint,
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
      (due (compute-due staker reward-cycle (get stx-out state) (get sbtc-out state)
        (get total-shares state)
      ))
    )
    (if (and (is-eq (get stx-due due) u0) (is-eq (get sbtc-due due) u0))
      (ok state)
      (begin
        (try! (pay-staker staker reward-cycle due))
        (ok (merge state {
          paid-count: (+ (get paid-count state) u1),
          total-stx: (+ (get total-stx state) (get stx-due due)),
          total-sbtc: (+ (get total-sbtc state) (get sbtc-due due)),
        }))
      )
    )
  )
)

;;; ---------------------------------------------------------------------------
;;; Read-only views
;;; ---------------------------------------------------------------------------

(define-read-only (is-admin (caller principal))
  (default-to false (map-get? admins caller))
)

(define-read-only (get-operator)
  (var-get operator)
)

(define-read-only (current-cycle)
  (contract-call? 'ST000000000000000000002AMW42H.pox-5 current-pox-reward-cycle)
)

(define-read-only (get-active-fee-bips)
  (if (>= (current-cycle) (var-get pending-fees-cycle))
    (var-get pending-fees-bips)
    (var-get fees-bips)
  )
)

(define-read-only (get-pending-fees)
  {
    pending-bips: (var-get pending-fees-bips),
    activation-cycle: (var-get pending-fees-cycle),
    active-bips: (get-active-fee-bips),
  }
)

(define-read-only (get-fee-bips-for-cycle (reward-cycle uint))
  (default-to (get-active-fee-bips) (map-get? fee-bips-for-cycle reward-cycle))
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

(define-read-only (get-vault-batch (vault principal))
  (map-get? vault-batches vault)
)

(define-read-only (get-settlement (reward-cycle uint))
  (default-to EMPTY_SETTLEMENT (map-get? cycle-settlement reward-cycle))
)

(define-read-only (is-pinned (reward-cycle uint))
  (get pinned (get-settlement reward-cycle))
)

(define-read-only (get-swap-status (reward-cycle uint))
  (let ((settlement (get-settlement reward-cycle)))
    (merge settlement {
      unfunded-sats: (unfunded-sats settlement),
      window-open: (and
        (> (get deadline settlement) u0)
        (<= burn-block-height (get deadline settlement))
      ),
    })
  )
)

(define-read-only (check-mirror (reward-cycle uint))
  (let (
      (local (default-to u0 (map-get? mirrored-total-shares reward-cycle)))
      (remote (contract-call? 'ST000000000000000000002AMW42H.pox-5
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
    (staker principal)
    (reward-cycle uint)
  )
  (default-to u0
    (map-get? mirrored-shares {
      staker: staker,
      reward-cycle: reward-cycle,
    })
  )
)

(define-read-only (get-mirrored-total-shares (reward-cycle uint))
  (default-to u0 (map-get? mirrored-total-shares reward-cycle))
)

;; What a staker is owed for a cycle right now. An unfunded remainder past the
;; window shows up only once `release-unfunded` (or a distribution) has run.
(define-read-only (get-staker-rewards
    (staker principal)
    (reward-cycle uint)
  )
  (let ((settlement (get-settlement reward-cycle)))
    (compute-due staker reward-cycle (get stx-out settlement)
      (get sbtc-out settlement) (get total-shares settlement)
    )
  )
)

;;; ---------------------------------------------------------------------------
;;; Rendezvous harness -- simnet only
;;; ---------------------------------------------------------------------------
;;
;;   pnpm test:rv:vault        # invariants, random call sequences
;;   pnpm test:rv:vault:prop   # properties, fuzzed single calls
;;
;; Every definition below carries `#[env(simnet)]`, which clarinet strips from
;; the publish source for any other network.
;;
;; Rendezvous only calls this contract, and pox-5 cannot produce a reward pot
;; for a random call sequence (it needs a registered signer, stakes and a full
;; cycle). So the harness adds a few `rv-*` entry points that let the fuzzer
;; reach every vault path anyway:
;;
;;   rv-seed-cycle      a claimed + pinned cycle with a real sBTC pot, two
;;                      stakers, and an open (or already closed) window. The
;;                      sBTC really moves, so every solvency check is real.
;;                      Seeded cycles start at RV_CYCLE_BASE, clear of any
;;                      cycle pox-5 could claim.
;;   rv-adopt-vault     make a mock vault active, with the production idle
;;                      checks but without the 4032-block notice period (the
;;                      real propose/confirm path is fuzzed too).
;;   rv-vault-sell      the mock "sells": its sBTC to the caller, the caller's
;;                      STX to it.
;;   rv-vault-mode      inject vault misbehaviour: short fund, over-reporting,
;;                      reverting finish/recover.
;;   rv-vault-reserve   STX the mock keeps back on finish.
;;   rv-donate-*        stray sBTC / STX sent to this contract.
;;
;; Rendezvous also mines random burn-block gaps between calls, so funding
;; windows close and recovery delays elapse in the middle of sequences.

;; #[env(simnet)]
(define-map context
  (string-ascii 100)
  { called: uint }
)

;; #[env(simnet)]
(define-private (update-context
    (function-name (string-ascii 100))
    (called uint)
  )
  (ok (map-set context function-name { called: called }))
)

;; #[env(simnet)]
(define-constant RV_CYCLE_BASE u1000000)

;; #[env(simnet)]
(define-data-var rv-next-cycle uint u0)

;; Real low cycles (anything a random `claim-rewards` might touch) plus the
;; first seeded cycles, where all the action is.
;; #[env(simnet)]
(define-constant PROBE_CYCLES (list u0 u1 u2 u3 u100 u1000 u1000000 u1000001 u1000002
  u1000003 u1000004 u1000005 u1000006 u1000007 u1000008 u1000009
))

;;; --- fixtures ---------------------------------------------------------------

;; #[env(simnet)]
(define-private (rv-seed
    (sats uint)
    (staker-a principal)
    (shares-a uint)
    (staker-b principal)
    (shares-b uint)
    (expired bool)
  )
  (let (
      (reward-cycle (+ RV_CYCLE_BASE (var-get rv-next-cycle)))
      (pot (+ u1 (mod sats u1000000)))
      (sa (+ u1 (mod shares-a u1000000000000)))
      (sb (+ u1 (mod shares-b u1000000000000)))
      ;; A staker listed twice holds the second figure, as a re-stake would.
      (total (if (is-eq staker-a staker-b)
        sb
        (+ sa sb)
      ))
    )
    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      transfer pot tx-sender current-contract none
    ))
    (var-set rv-next-cycle (+ (var-get rv-next-cycle) u1))
    (map-set mirrored-shares {
      staker: staker-a,
      reward-cycle: reward-cycle,
    }
      sa
    )
    (map-set mirrored-shares {
      staker: staker-b,
      reward-cycle: reward-cycle,
    }
      sb
    )
    (map-set mirrored-total-shares reward-cycle total)
    (var-set unswapped-sats (+ (var-get unswapped-sats) pot))
    (map-set fee-bips-for-cycle reward-cycle (get-active-fee-bips))
    (map-set cycle-settlement reward-cycle
      (merge EMPTY_SETTLEMENT {
        pot-sats: pot,
        total-shares: total,
        pinned: true,
        ;; "expired": the window closed one block ago.
        deadline: (if expired
          (- burn-block-height u1)
          (+ burn-block-height SWAP_WINDOW_BURN_BLOCKS)
        ),
      })
    )
    (ok {
      reward-cycle: reward-cycle,
      pot: pot,
      shares-a: sa,
      shares-b: sb,
      total: total,
    })
  )
)

;; #[env(simnet)]
(define-public (rv-seed-cycle
    (sats uint)
    (staker-a principal)
    (shares-a uint)
    (staker-b principal)
    (shares-b uint)
  )
  (rv-seed sats staker-a shares-a staker-b shares-b false)
)

;; #[env(simnet)]
(define-public (rv-adopt-vault (vault <swap-vault-trait>))
  (begin
    (try! (assert-idle-vault vault))
    (ok (var-set swap-vault (contract-of vault)))
  )
)

;; #[env(simnet)]
(define-public (rv-vault-sell
    (second bool)
    (sats uint)
    (ustx uint)
  )
  (let (
      (vault (if second
        .mock-swap-vault-2
        .mock-swap-vault
      ))
      (held (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        get-balance vault
      )))
      ;; Half the time sell out, so the batch closes and `finish` is reachable.
      (sold (if (is-eq (mod sats u2) u0)
        held
        (mod sats (+ held u1))
      ))
      (paid (mod ustx u100000000000))
    )
    (if second
      (contract-call? .mock-swap-vault-2 sell sold paid)
      (contract-call? .mock-swap-vault sell sold paid)
    )
  )
)

;; #[env(simnet)]
(define-public (rv-vault-mode
    (second bool)
    (mode uint)
  )
  (if second
    (contract-call? .mock-swap-vault-2 set-mode (mod mode u4))
    (contract-call? .mock-swap-vault set-mode (mod mode u4))
  )
)

;; #[env(simnet)]
(define-public (rv-vault-reserve
    (second bool)
    (ustx uint)
  )
  (if second
    (contract-call? .mock-swap-vault-2 set-reserve (mod ustx u10000000))
    (contract-call? .mock-swap-vault set-reserve (mod ustx u10000000))
  )
)

;; #[env(simnet)]
(define-public (rv-donate-sbtc (sats uint))
  (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
    transfer (+ u1 (mod sats u100000)) tx-sender current-contract none
  )
)

;; #[env(simnet)]
(define-public (rv-donate-stx (ustx uint))
  (stx-transfer? (+ u1 (mod ustx u100000000)) tx-sender current-contract)
)

;; Random cycle numbers almost never hit a seeded cycle, so these route a random
;; `pick` onto one and call the real entry point. Each runs as its own top-level
;; transaction, so a failure rolls back exactly as it would on chain.
;; #[env(simnet)]
(define-read-only (rv-cycle (pick uint))
  (+ RV_CYCLE_BASE (mod pick (+ (var-get rv-next-cycle) u1)))
)

;; #[env(simnet)]
(define-public (rv-fund
    (pick uint)
    (vault <swap-vault-trait>)
  )
  (fund-swap-vault (rv-cycle pick) vault)
)

;; Seed a cycle and fund it straight away, in one transaction, so batches are
;; common even when Rendezvous mines past funding windows between calls.
;; #[env(simnet)]
(define-public (rv-seed-and-fund
    (sats uint)
    (staker-a principal)
    (shares-a uint)
    (staker-b principal)
    (shares-b uint)
    (vault <swap-vault-trait>)
  )
  (let ((seed (try! (rv-seed sats staker-a shares-a staker-b shares-b false))))
    (fund-swap-vault (get reward-cycle seed) vault)
  )
)

;; #[env(simnet)]
(define-public (rv-release (pick uint))
  (release-unfunded (rv-cycle pick))
)

;; #[env(simnet)]
(define-public (rv-distribute
    (pick uint)
    (staker principal)
  )
  (distribute-rewards staker (rv-cycle pick))
)

;; #[env(simnet)]
(define-public (rv-distribute-many
    (pick uint)
    (stakers (list 10 principal))
  )
  (distribute-rewards-many stakers (rv-cycle pick))
)

;;; --- invariants -------------------------------------------------------------

;; Every micro-STX promised to a staker is actually here.
;; #[env(simnet)]
(define-read-only (invariant-stx-liability-is-covered)
  (<= (var-get unpaid-stx) (stx-get-balance current-contract))
)

;; Fees plus the staker sBTC liability never exceed the balance. This is what
;; makes `sweep-sbtc-dust` safe.
;; #[env(simnet)]
(define-read-only (invariant-sbtc-liability-is-covered)
  (<= (+ (var-get earned-fees) (var-get unswapped-sats)) (sbtc-balance))
)

;; #[env(simnet)]
(define-read-only (invariant-fee-never-exceeds-cap)
  (and
    (<= (get-active-fee-bips) MAX_FEE_BIPS)
    (<= (var-get fees-bips) MAX_FEE_BIPS)
    (<= (var-get pending-fees-bips) MAX_FEE_BIPS)
  )
)

;; #[env(simnet)]
(define-read-only (invariant-snapshotted-fees-within-cap)
  (fold check-cycle-fee PROBE_CYCLES true)
)

;; #[env(simnet)]
(define-private (check-cycle-fee
    (reward-cycle uint)
    (acc bool)
  )
  (and acc (<= (get-fee-bips-for-cycle reward-cycle) MAX_FEE_BIPS))
)

;; #[env(simnet)]
(define-read-only (invariant-cycle-accounting-is-consistent)
  (fold check-cycle PROBE_CYCLES true)
)

;; #[env(simnet)]
(define-private (check-cycle
    (reward-cycle uint)
    (acc bool)
  )
  (let ((s (get-settlement reward-cycle)))
    (and
      acc
      ;; Nothing leaves the pot twice.
      (<= (+ (get funded-sats s) (get released-sats s)) (get pot-sats s))
      ;; Fees come out of what left the pot, at no more than the cap.
      (<= (get fee-sats s) (+ (get funded-sats s) (get released-sats s)))
      (<= (* (get fee-sats s) BIPS_DENOMINATOR)
        (* (+ (get funded-sats s) (get released-sats s)) MAX_FEE_BIPS)
      )
      ;; A vault never holds more for a cycle than was funded for it.
      (<= (get in-vault-sats s) (get funded-sats s))
      ;; STX only arrives from a vault, and a vault only holds funded sBTC.
      (or (is-eq (get stx-out s) u0) (> (get funded-sats s) u0))
      ;; Payable sBTC is released or recovered sBTC, both bounded by the pot.
      ;; (The mock vault cannot receive sBTC donations in this harness.)
      (<= (get sbtc-out s) (+ (get funded-sats s) (get released-sats s)))
      ;; Released only after the window, and only when it has closed.
      (or (is-eq (get released-sats s) u0) (> (get deadline s) u0))
      (or (is-eq (get deadline s) u0) (> (get pot-sats s) u0))
      (or (get pinned s) (is-eq (get total-shares s) u0))
      (or (not (get pinned s)) (> (get deadline s) u0))
    )
  )
)

;; A cycle's in-vault figure is exactly the batches the vaults hold for it.
;; Catches a batch that is closed without being booked, or booked twice.
;; #[env(simnet)]
(define-read-only (invariant-in-vault-matches-batches)
  (fold check-in-vault PROBE_CYCLES true)
)

;; #[env(simnet)]
(define-private (batch-sats-for
    (vault principal)
    (reward-cycle uint)
  )
  (match (map-get? vault-batches vault)
    batch (if (is-eq (get reward-cycle batch) reward-cycle)
      (get sats batch)
      u0
    )
    u0
  )
)

;; #[env(simnet)]
(define-private (check-in-vault
    (reward-cycle uint)
    (acc bool)
  )
  (and
    acc
    (is-eq (get in-vault-sats (get-settlement reward-cycle))
      (+ (batch-sats-for .mock-swap-vault reward-cycle)
        (batch-sats-for .mock-swap-vault-2 reward-cycle)
        (batch-sats-for .fastpool-swap-vault reward-cycle)
      ))
  )
)

;; A batch this contract records is one the vault is actually working, and
;; never more than the vault took.
;; #[env(simnet)]
(define-read-only (invariant-batches-are-live)
  (and
    (check-batch-live .mock-swap-vault)
    (check-batch-live .mock-swap-vault-2)
    ;; Nothing can ever be funded into a contract that does not exist.
    (is-none (map-get? vault-batches .fastpool-swap-vault))
  )
)

;; #[env(simnet)]
(define-private (check-batch-live (vault principal))
  (match (map-get? vault-batches vault)
    batch (<= (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      get-balance vault
    ))
      (get sats batch)
    )
    true
  )
)

;; A staker is never paid more than their current entitlement, on either leg.
;; Checked for whichever account Rendezvous reads the invariant as.
;; #[env(simnet)]
(define-read-only (invariant-paid-never-exceeds-entitlement)
  (fold check-paid PROBE_CYCLES true)
)

;; #[env(simnet)]
(define-private (check-paid
    (reward-cycle uint)
    (acc bool)
  )
  (let (
      (due (get-staker-rewards tx-sender reward-cycle))
      (s (get-settlement reward-cycle))
    )
    (and
      acc
      (<= (get stx-paid due) (get stx-entitled due))
      (<= (get sbtc-paid due) (get sbtc-entitled due))
      (<= (get stx-entitled due) (get stx-out s))
      (<= (get sbtc-entitled due) (get sbtc-out s))
      (or
        (> (get total-shares s) u0)
        (and (is-eq (get stx-due due) u0) (is-eq (get sbtc-due due) u0))
      )
    )
  )
)

;; A cleared proposal leaves nothing behind, and the active vault is always one
;; this harness knows.
;; #[env(simnet)]
(define-read-only (invariant-vault-config-is-sane)
  (and
    (or
      (is-some (var-get pending-swap-vault))
      (is-eq (var-get pending-swap-vault-height) u0)
    )
    (or
      (is-eq (var-get swap-vault) .fastpool-swap-vault)
      (is-eq (var-get swap-vault) .mock-swap-vault)
      (is-eq (var-get swap-vault) .mock-swap-vault-2)
    )
  )
)

;;; --- properties -------------------------------------------------------------
;;
;; Each property returns (ok false) to discard a run whose preconditions do not
;; hold, and leaves the vault idle so the next run can use it. None of them
;; drives a call into a path that writes and then fails: inside one
;; transaction an internal `err` does not roll back, so that would leave a
;; state no real transaction can reach.

;; #[env(simnet)]
(define-private (admin-only)
  (and (is-eq contract-caller tx-sender) (is-admin tx-sender))
)

;; Make the first mock the active, healthy, idle vault; false if it is busy.
;; #[env(simnet)]
(define-private (rv-ready-vault)
  (if (is-some (map-get? vault-batches .mock-swap-vault))
    false
    (begin
      (unwrap-panic (contract-call? .mock-swap-vault set-mode u0))
      (unwrap-panic (contract-call? .mock-swap-vault set-reserve u0))
      (var-set swap-vault .mock-swap-vault)
      true
    )
  )
)

;; #[env(simnet)]
(define-private (test-update-fees-rejects-above-cap (new-fees uint))
  (begin
    (asserts! (or (<= new-fees MAX_FEE_BIPS) (is-err (update-fees new-fees)))
      (err u9001)
    )
    (ok true)
  )
)

;; #[env(simnet)]
(define-private (test-update-fees-accepts-up-to-cap (new-fees uint))
  (if (not (admin-only))
    (ok false)
    (begin
      (asserts! (or (> new-fees MAX_FEE_BIPS) (is-ok (update-fees new-fees)))
        (err u9002)
      )
      (ok true)
    )
  )
)

;; A fee increase is queued, never active in the cycle it is set; a decrease
;; applies at once. `raw` is folded into 0..MAX_FEE_BIPS so the generator lands
;; inside the cap instead of being discarded.
;; #[env(simnet)]
(define-private (test-fee-change-timing (raw uint))
  (if (not (admin-only))
    (ok false)
    (let (
        (new-fees (mod raw (+ MAX_FEE_BIPS u1)))
        (before (get-active-fee-bips))
      )
      (try! (update-fees new-fees))
      (asserts!
        (is-eq (get-active-fee-bips)
          (if (> new-fees before)
            before
            new-fees
          ))
        (err u9003)
      )
      (ok true)
    )
  )
)

;; #[env(simnet)]
(define-private (test-pin-shares-is-idempotent (reward-cycle uint))
  (let ((first (pin-shares reward-cycle)))
    (asserts! (is-eq (is-ok first) (is-ok (pin-shares reward-cycle))) (err u9004))
    (asserts! (or (is-err first) (is-eq first (pin-shares reward-cycle)))
      (err u9005)
    )
    (ok true)
  )
)

;; Funding sends exactly gross - fee to the vault, books the fee, and takes
;; gross off the staker liability. Then a full sale books exactly what arrived.
;; #[env(simnet)]
(define-private (test-fund-then-finalize-books-exactly
    (sats uint)
    (staker-a principal)
    (shares-a uint)
    (staker-b principal)
    (shares-b uint)
    (ustx uint)
  )
  (if (not (rv-ready-vault))
    (ok false)
    (let (
        (seed (try! (rv-seed sats staker-a shares-a staker-b shares-b false)))
        (reward-cycle (get reward-cycle seed))
        (gross (get pot seed))
        (fee (/ (* gross (get-fee-bips-for-cycle reward-cycle)) BIPS_DENOMINATOR))
        (fees-before (var-get earned-fees))
        (liability-before (var-get unswapped-sats))
        (net (try! (fund-swap-vault reward-cycle .mock-swap-vault)))
        (paid (mod ustx u100000000000))
      )
      (asserts! (is-eq net (- gross fee)) (err u9010))
      (asserts! (is-eq (var-get earned-fees) (+ fees-before fee)) (err u9011))
      (asserts! (is-eq (var-get unswapped-sats) (- liability-before gross))
        (err u9012)
      )
      (asserts!
        (is-eq (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          get-balance .mock-swap-vault
        ))
          net
        )
        (err u9013)
      )
      ;; Over-report on purpose: the booking must follow the balance.
      (unwrap-panic (contract-call? .mock-swap-vault set-mode u2))
      (try! (contract-call? .mock-swap-vault sell net paid))
      (let (
          (unpaid-before (var-get unpaid-stx))
          (booked (try! (finalize-swap-vault .mock-swap-vault)))
        )
        (unwrap-panic (contract-call? .mock-swap-vault set-mode u0))
        (asserts! (is-eq (get stx booked) paid) (err u9014))
        (asserts! (is-eq (var-get unpaid-stx) (+ unpaid-before paid)) (err u9015))
        (asserts! (is-eq (get stx-out (get-settlement reward-cycle)) paid)
          (err u9016)
        )
        (asserts! (is-eq (get in-vault-sats (get-settlement reward-cycle)) u0)
          (err u9017)
        )
        (ok true)
      )
    )
  )
)

;; A cycle whose window closed without funding is released net of fees and
;; paid pro-rata in sBTC, exactly once; and it can no longer be funded.
;; #[env(simnet)]
(define-private (test-closed-window-releases-and-pays-pro-rata
    (sats uint)
    (staker-a principal)
    (shares-a uint)
    (staker-b principal)
    (shares-b uint)
  )
  (if (or (is-eq staker-a staker-b) (not (rv-ready-vault)))
    (ok false)
    (let (
        (seed (try! (rv-seed sats staker-a shares-a staker-b shares-b true)))
        (reward-cycle (get reward-cycle seed))
        (gross (get pot seed))
        (fee (/ (* gross (get-fee-bips-for-cycle reward-cycle)) BIPS_DENOMINATOR))
        (net (- gross fee))
        (due-a (/ (* net (get shares-a seed)) (get total seed)))
        (due-b (/ (* net (get shares-b seed)) (get total seed)))
        (bal-a (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          get-balance staker-a
        )))
        (bal-b (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          get-balance staker-b
        )))
      )
      (asserts! (is-eq (fund-swap-vault reward-cycle .mock-swap-vault)
        ERR_SWAP_WINDOW_CLOSED
      )
        (err u9020)
      )
      (try! (distribute-rewards-many (list staker-a staker-b) reward-cycle))
      (asserts! (is-eq (get sbtc-out (get-settlement reward-cycle)) net) (err u9021))
      (asserts!
        (is-eq (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          get-balance staker-a
        ))
          (+ bal-a due-a)
        )
        (err u9022)
      )
      (asserts!
        (is-eq (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
          get-balance staker-b
        ))
          (+ bal-b due-b)
        )
        (err u9023)
      )
      ;; Second run: nothing more is released or paid.
      (asserts! (is-eq (release-unfunded reward-cycle) (ok u0)) (err u9024))
      (asserts!
        (is-eq
          (get paid
            (try! (distribute-rewards-many (list staker-a staker-b) reward-cycle))
          )
          u0
        )
        (err u9025)
      )
      (ok true)
    )
  )
)

;; A seeded cycle funded and fully sold pays STX pro-rata, exactly once.
;; #[env(simnet)]
(define-private (test-stx-payout-is-pro-rata
    (sats uint)
    (staker-a principal)
    (shares-a uint)
    (staker-b principal)
    (shares-b uint)
    (ustx uint)
  )
  (if (or
      (is-eq staker-a staker-b)
      (is-eq staker-a tx-sender)
      (is-eq staker-b tx-sender)
      (not (rv-ready-vault))
    )
    (ok false)
    (let (
        (seed (try! (rv-seed sats staker-a shares-a staker-b shares-b false)))
        (reward-cycle (get reward-cycle seed))
        (net (try! (fund-swap-vault reward-cycle .mock-swap-vault)))
        (paid (+ u1 (mod ustx u100000000000)))
        (bal-a (stx-get-balance staker-a))
        (bal-b (stx-get-balance staker-b))
      )
      (try! (contract-call? .mock-swap-vault sell net paid))
      (try! (finalize-swap-vault .mock-swap-vault))
      (try! (distribute-rewards-many (list staker-a staker-b) reward-cycle))
      (asserts!
        (is-eq (stx-get-balance staker-a)
          (+ bal-a (/ (* paid (get shares-a seed)) (get total seed)))
        )
        (err u9030)
      )
      (asserts!
        (is-eq (stx-get-balance staker-b)
          (+ bal-b (/ (* paid (get shares-b seed)) (get total seed)))
        )
        (err u9031)
      )
      (asserts!
        (is-eq
          (get paid
            (try! (distribute-rewards-many (list staker-a staker-b) reward-cycle))
          )
          u0
        )
        (err u9032)
      )
      (ok true)
    )
  )
)

;; A busy vault cannot take a second batch, and a vault never funded cannot be
;; settled.
;; #[env(simnet)]
(define-private (test-one-batch-per-vault
    (sats uint)
    (staker-a principal)
    (shares-a uint)
    (staker-b principal)
    (shares-b uint)
  )
  (if (or
      (not (rv-ready-vault))
      (is-some (map-get? vault-batches .mock-swap-vault-2))
    )
    (ok false)
    (let (
        (first (try! (rv-seed sats staker-a shares-a staker-b shares-b false)))
        (second (try! (rv-seed sats staker-a shares-a staker-b shares-b false)))
        (net (try! (fund-swap-vault (get reward-cycle first) .mock-swap-vault)))
      )
      (asserts!
        (is-eq (fund-swap-vault (get reward-cycle second) .mock-swap-vault)
          ERR_VAULT_BUSY
        )
        (err u9040)
      )
      (asserts! (is-eq (finalize-swap-vault .mock-swap-vault-2) ERR_NO_VAULT_BATCH)
        (err u9041)
      )
      (asserts! (is-eq (recover-swap-vault .mock-swap-vault-2) ERR_NO_VAULT_BATCH)
        (err u9042)
      )
      ;; Leave the vault idle.
      (try! (contract-call? .mock-swap-vault sell net u0))
      (try! (finalize-swap-vault .mock-swap-vault))
      (ok true)
    )
  )
)

;; Only the active vault takes new batches, and vault settings stay inside this
;; contract's bounds whoever asks.
;; #[env(simnet)]
(define-private (test-vault-settings-are-bounded (bps uint))
  (if (not (rv-ready-vault))
    (ok false)
    (begin
      (asserts!
        (or
          (<= bps MAX_VAULT_SLIPPAGE_BPS)
          (is-err (set-vault-slippage-bps bps .mock-swap-vault))
        )
        (err u9050)
      )
      (asserts!
        (or
          (<= bps MAX_VAULT_LEEWAY_BPS)
          (is-err (set-vault-leeway-bps bps .mock-swap-vault))
        )
        (err u9051)
      )
      (asserts!
        (or
          (<= bps MAX_VAULT_NO_PYTH_SLIPPAGE_BPS)
          (is-err (set-vault-no-pyth-slippage-bps bps .mock-swap-vault))
        )
        (err u9052)
      )
      (asserts!
        (or
          (and (>= bps MIN_VAULT_DIA_BAND_BPS) (<= bps MAX_VAULT_DIA_BAND_BPS))
          (is-err (set-vault-dia-band-bps bps .mock-swap-vault))
        )
        (err u9053)
      )
      ;; Not the active vault: refused whatever the value.
      (asserts! (is-err (set-vault-slippage-bps u0 .mock-swap-vault-2)) (err u9054))
      (ok true)
    )
  )
)

;; Nobody but the operator can trade, and nobody but an admin can rotate.
;; #[env(simnet)]
(define-private (test-roles-are-enforced (amount uint))
  (if (not (rv-ready-vault))
    (ok false)
    (begin
      (asserts!
        (or
          (is-eq tx-sender (var-get operator))
          (is-eq (jing-take amount 0x .mock-swap-vault) ERR_UNAUTHORIZED_OPERATOR)
        )
        (err u9060)
      )
      (asserts!
        (or
          (admin-only)
          (is-eq (propose-swap-vault .mock-swap-vault-2) ERR_UNAUTHORIZED_ADMIN)
        )
        (err u9061)
      )
      (asserts!
        (or (admin-only) (is-eq (sweep-sbtc-dust tx-sender) ERR_UNAUTHORIZED_ADMIN))
        (err u9062)
      )
      (ok true)
    )
  )
)

;; A sweep takes exactly the stray balance and leaves every liability covered.
;; #[env(simnet)]
(define-private (test-sweep-takes-only-strays (sats uint))
  (if (not (admin-only))
    (ok false)
    (let (
        (stray (+ u1 (mod sats u100000)))
        (reserved (+ (var-get earned-fees) (var-get unswapped-sats)))
      )
      (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
        transfer stray tx-sender current-contract none
      ))
      (let (
          (balance (sbtc-balance))
          (swept (try! (sweep-sbtc-dust tx-sender)))
        )
        (asserts! (is-eq swept (- balance reserved)) (err u9070))
        (asserts! (is-eq (sbtc-balance) reserved) (err u9071))
        (ok true)
      )
    )
  )
)
