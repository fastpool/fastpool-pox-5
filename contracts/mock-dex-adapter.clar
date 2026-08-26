;; title: mock-dex-adapter
;; A stand-in DEX for testing `fastpool-stx-rewards-signer-manager`.
;;
;; No Stacks DEX has sBTC/STX liquidity in simnet, so the unit tests run
;; against this instead: a fixed owner-set rate, plus injectable failure modes
;; for the cases that matter (under-delivery, no delivery, revert). The real
;; adapters -- Bitflow DLMM, Bitflow standard, ALEX, Velar -- are validated
;; against mainnet-fork tests instead, since a transposed argument in a real
;; router call is not catchable here.
;;
;; It behaves like a real pool in the one way that matters for the signer
;; manager's guards: it pulls the sBTC from `tx-sender` (which, inside the
;; signer manager's `as-contract?`, is the signer manager) and sends the STX
;; straight back to that same principal.

(impl-trait .dex-traits.dex-adapter-trait)
;; The same mock also stands in for a proof-carrying venue, so the two swap
;; entry points can be tested against identical pricing and identical failure
;; modes -- any difference in a test is then a difference in the manager, not
;; in the stub.
(impl-trait .dex-traits.dex-adapter-proof-trait)

(define-constant ERR_UNAUTHORIZED (err u3001))
(define-constant ERR_MODE_REVERT (err u3002))

(define-constant SCALE u100000000)

;; Failure modes, for the tests.
(define-constant MODE_NORMAL u0)
;; Deliver one micro-STX less than `min-stx-out`.
(define-constant MODE_UNDER_DELIVER u1)
;; Take the sBTC and deliver nothing.
(define-constant MODE_DELIVER_NOTHING u2)
;; Revert outright.
(define-constant MODE_REVERT u3)

(define-data-var owner principal tx-sender)
;; Micro-STX delivered per satoshi, scaled by SCALE.
(define-data-var rate-scaled uint u0)
(define-data-var mode uint MODE_NORMAL)

;; The last proof this adapter was handed, so a test can prove the manager
;; forwards the payload through untouched rather than dropping or mangling it.
(define-data-var last-proof (buff 8192) 0x)

(define-public (swap-sbtc-to-stx
    (amount-sats uint)
    (min-stx-out uint)
  )
  (let (
      ;; Captured before the `as-contract?` below rebinds `tx-sender`.
      (recipient tx-sender)
      (current-mode (var-get mode))
      (quoted (/ (* amount-sats (var-get rate-scaled)) SCALE))
    )
    (asserts! (not (is-eq current-mode MODE_REVERT)) ERR_MODE_REVERT)
    (try! (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      transfer amount-sats recipient current-contract none
    ))
    (let ((delivered (if (is-eq current-mode MODE_DELIVER_NOTHING)
        u0
        (if (is-eq current-mode MODE_UNDER_DELIVER)
          (if (> min-stx-out u0)
            (- min-stx-out u1)
            u0
          )
          quoted
        )
      )))
      (if (> delivered u0)
        (try! (as-contract?
          ((with-stx delivered))
          (try! (stx-transfer? delivered tx-sender recipient))
        ))
        true
      )
      (print {
        topic: "swap-sbtc-to-stx",
        amount-sats: amount-sats,
        min-stx-out: min-stx-out,
        delivered: delivered,
        mode: current-mode,
      })
      (ok delivered)
    )
  )
)

;; The proof-carrying entry point. Records the payload, then does exactly what
;; the plain path does -- pricing, modes and all.
(define-public (swap-sbtc-to-stx-with-proof
    (amount-sats uint)
    (min-stx-out uint)
    (proof (buff 8192))
  )
  (begin
    (var-set last-proof proof)
    (swap-sbtc-to-stx amount-sats min-stx-out)
  )
)

(define-read-only (get-last-proof)
  (var-get last-proof)
)

;; Give the pool STX to sell.
(define-public (fund (amount uint))
  (stx-transfer? amount tx-sender current-contract)
)

(define-public (set-rate (rate uint))
  (begin
    (asserts! (is-eq tx-sender (var-get owner)) ERR_UNAUTHORIZED)
    (ok (var-set rate-scaled rate))
  )
)

(define-public (set-mode (new-mode uint))
  (begin
    (asserts! (is-eq tx-sender (var-get owner)) ERR_UNAUTHORIZED)
    (ok (var-set mode new-mode))
  )
)

(define-read-only (get-rate)
  (var-get rate-scaled)
)

(define-read-only (get-mode)
  (var-get mode)
)

(define-read-only (get-scale)
  SCALE
)
