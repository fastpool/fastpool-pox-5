;; title: mock-swap-vault
;; A stand-in for `fastpool-swap-vault`, for testing
;; `signer-manager-vault-stx-rewards` in simnet.
;;
;; The real vault trades on Jing and reads Pyth/DIA, none of which exist in
;; simnet. This mock keeps the parts of its contract the signer manager relies
;; on -- `fund` pulls sBTC from the pool, one batch at a time; `finish` returns
;; the STX balance less a kept-back reserve once the batch is sold;
;; `emergency-recover` returns everything after RECOVERY_DELAY_BLOCKS -- and
;; replaces trading with an owner-driven `sell`. Injectable misbehaviour covers
;; the signer manager's defensive checks.

(impl-trait 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.juice-swap-vault-trait-v2.swap-vault-trait)

(define-constant ERR_UNAUTHORIZED (err u16000))
(define-constant ERR_BUSY (err u16045))
(define-constant ERR_NO_CLOCK (err u16032))
(define-constant ERR_RECOVERY_TOO_SOON (err u16046))
(define-constant ERR_SOME_FUNDS (err u16043))
(define-constant ERR_MODE_REVERT (err u16099))

(define-constant POOL .signer-manager-vault-stx-rewards)
(define-constant SBTC 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant RECOVERY_DELAY_BLOCKS u432)

(define-constant MODE_NORMAL u0)
;; `fund` takes one sat less than asked.
(define-constant MODE_FUND_SHORT u1)
;; `finish` / `emergency-recover` report more than they send.
(define-constant MODE_OVERREPORT u2)
;; `finish` / `emergency-recover` revert.
(define-constant MODE_REVERT u3)

(define-data-var mode uint MODE_NORMAL)
(define-data-var batch-start (optional uint) none)
(define-data-var ready-to-finish bool false)
;; STX kept back on `finish`, like the real vault's pyth-fee-budget.
(define-data-var reserve uint u0)
;; What `get-upgrade-status` reports, so tests can make the vault look foreign
;; or busy.
(define-data-var reported-pool (optional principal) none)
(define-data-var jing-resting uint u0)
;; The last setter or trade call, so tests can see what was forwarded.
(define-data-var last-call {
  name: (string-ascii 32),
  value: uint,
} {
  name: "",
  value: u0,
})

;;; Test controls
;;
;; Open to any caller, so Rendezvous can drive them from random senders. This
;; is a test double; nothing here guards real funds.

(define-public (set-mode (m uint))
  (begin
    (ok (var-set mode m))
  )
)

(define-public (set-reserve (ustx uint))
  (begin
    (ok (var-set reserve ustx))
  )
)

(define-public (set-reported-pool (p (optional principal)))
  (begin
    (ok (var-set reported-pool p))
  )
)

(define-public (set-jing-resting (sats uint))
  (begin
    (ok (var-set jing-resting sats))
  )
)

;; Simulate a sale: `sats` of the vault's sBTC leave to the caller, `ustx` of
;; the caller's STX arrive. Closes the batch when no sBTC is left.
(define-public (sell
    (sats uint)
    (ustx uint)
  )
  (let ((buyer tx-sender))
    (and
      (> sats u0)
      (try! (as-contract? ((with-ft SBTC "sbtc-token" sats))
        (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer sats current-contract buyer none))
      ))
    )
    (and (> ustx u0) (try! (stx-transfer? ustx tx-sender current-contract)))
    (if (and (is-some (var-get batch-start)) (is-eq (sbtc-balance) u0))
      (begin
        (var-set batch-start none)
        (var-set ready-to-finish true)
      )
      true
    )
    (ok true)
  )
)

;;; Pool-facing API

(define-public (fund (amount uint))
  (let ((taken (if (is-eq (var-get mode) MODE_FUND_SHORT)
      (- amount u1)
      amount
    )))
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (is-none (var-get batch-start)) ERR_BUSY)
    (asserts! (not (var-get ready-to-finish)) ERR_BUSY)
    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer taken POOL current-contract none))
    (var-set batch-start (some burn-block-height))
    (ok amount)
  )
)

(define-public (finish)
  (let (
      (balance (stx-get-balance current-contract))
      (amount (if (> balance (var-get reserve))
        (- balance (var-get reserve))
        u0
      ))
    )
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (not (is-eq (var-get mode) MODE_REVERT)) ERR_MODE_REVERT)
    (asserts! (var-get ready-to-finish) ERR_NO_CLOCK)
    (and
      (> amount u0)
      (try! (as-contract? ((with-stx amount))
        (try! (stx-transfer? amount current-contract POOL))
      ))
    )
    (var-set ready-to-finish false)
    (ok (if (is-eq (var-get mode) MODE_OVERREPORT)
      (+ amount u1000000)
      amount
    ))
  )
)

(define-public (emergency-recover)
  (let (
      (start (unwrap! (var-get batch-start) ERR_NO_CLOCK))
      (sbtc (sbtc-balance))
      (stx (stx-get-balance current-contract))
    )
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (not (is-eq (var-get mode) MODE_REVERT)) ERR_MODE_REVERT)
    (asserts! (>= burn-block-height (+ start RECOVERY_DELAY_BLOCKS))
      ERR_RECOVERY_TOO_SOON
    )
    (and
      (> sbtc u0)
      (try! (as-contract? ((with-ft SBTC "sbtc-token" sbtc))
        (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token transfer sbtc current-contract POOL none))
      ))
    )
    (and
      (> stx u0)
      (try! (as-contract? ((with-stx stx))
        (try! (stx-transfer? stx current-contract POOL))
      ))
    )
    (var-set batch-start none)
    (var-set ready-to-finish false)
    (ok (if (is-eq (var-get mode) MODE_OVERREPORT)
      {
        stx: (+ stx u1000000),
        sbtc: (+ sbtc u1000),
      }
      {
        stx: stx,
        sbtc: sbtc,
      }
    ))
  )
)

(define-read-only (get-upgrade-status)
  (ok {
    pool: (default-to POOL (var-get reported-pool)),
    empty: (is-eq (sbtc-balance) u0),
    sbtc-balance: (sbtc-balance),
    stx-balance: (stx-get-balance current-contract),
    batch-start: (var-get batch-start),
    jing-resting: (var-get jing-resting),
    jing-parked: u0,
  })
)

(define-private (record
    (name (string-ascii 32))
    (value uint)
  )
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (var-set last-call {
      name: name,
      value: value,
    })
    (ok true)
  )
)

(define-public (jing-refloor (update (buff 8192)))
  (begin
    (try! (record "jing-refloor" (len update)))
    (ok u1)
  )
)

(define-public (set-window-blocks (blocks uint))
  (record "set-window-blocks" blocks)
)

(define-public (set-leeway-bps (bps uint))
  (record "set-leeway-bps" bps)
)

(define-public (set-slippage-bps (bps uint))
  (record "set-slippage-bps" bps)
)

(define-public (set-max-chunk-sats (sats uint))
  (record "set-max-chunk-sats" sats)
)

(define-public (set-dia-band-bps (bps uint))
  (record "set-dia-band-bps" bps)
)

(define-public (set-router-cooldown (blocks uint))
  (record "set-router-cooldown" blocks)
)

(define-public (set-no-pyth-slippage-bps (bps uint))
  (record "set-no-pyth-slippage-bps" bps)
)

(define-public (set-pyth-fee-budget (ustx uint))
  (record "set-pyth-fee-budget" ustx)
)

(define-public (set-maker-spread-bps (bps uint))
  (record "set-maker-spread-bps" bps)
)

(define-public (jing-take
    (amount uint)
    (update (buff 8192))
  )
  (begin
    (try! (record "jing-take" amount))
    (ok {
      notification: "jing-take",
      payload: {
        amount: amount,
        limit-price: u0,
        out: u0,
      },
    })
  )
)

(define-public (router-swap-split
    (amount uint)
    (jing uint)
    (dlmm uint)
    (xyk uint)
    (velar uint)
    (update (buff 8192))
  )
  (begin
    (try! (record "router-swap-split" amount))
    (ok {
      notification: "router-swap-split",
      payload: {
        amount: amount,
        jing: jing,
        dlmm: dlmm,
        xyk: xyk,
        velar: velar,
        limit-price: u0,
        velar-limit: u0,
        mid: u0,
        out: u0,
        unsold: u0,
      },
    })
  )
)

(define-public (router-swap-split-dia
    (amount uint)
    (dlmm uint)
    (xyk uint)
    (velar uint)
  )
  (begin
    (try! (record "router-swap-split-dia" amount))
    (ok {
      notification: "router-swap-split-dia",
      payload: {
        amount: amount,
        dlmm: dlmm,
        xyk: xyk,
        velar: velar,
        mid: u0,
        limit-price: u0,
        price-source: "dia",
        dia-error: none,
        out: u0,
        unsold: u0,
      },
    })
  )
)

(define-read-only (get-last-call)
  (var-get last-call)
)

(define-read-only (sbtc-balance)
  (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token get-balance current-contract))
)
