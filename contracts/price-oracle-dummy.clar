;; title: price-oracle-dummy
;; A placeholder baseline price feed for `fastpool-stx-rewards-signer-manager`.
;;
;; The signer manager uses the baseline only as a sanity floor on the
;; operator's `min-stx-out` -- it is not a pricing feed, and the floor is set
;; wide on purpose. This implementation is an owner-set rate, which is enough
;; to bring the guard online and to make every slippage test deterministic.
;;
;; The intended replacement derives the baseline from miner commitments: the
;; sats miners pay to stackers over a cycle, divided by the STX coinbase minted
;; in it (a fixed 1000 STX per tenure). See section 8 of
;; docs/plan-fastpool-stx-rewards.md.

(impl-trait .dex-traits.price-oracle-trait)

(define-constant ERR_UNAUTHORIZED (err u2001))

;; The rate is held as micro-STX per satoshi scaled by SCALE, so that a sub-1
;; ratio survives integer division. At ~1 BTC = 30,000 STX, one sat is worth
;; ~300 uSTX, so the scaling is not strictly needed today -- it is there so the
;; feed does not silently truncate to zero if that ratio ever inverts.
(define-constant SCALE u100000000)

(define-data-var owner principal tx-sender)
(define-data-var ustx-per-sat-scaled uint u0)

(define-read-only (sats-to-ustx (sats uint))
  (ok (/ (* sats (var-get ustx-per-sat-scaled)) SCALE))
)

(define-public (set-rate (ustx-per-sat-scaled-value uint))
  (begin
    (asserts! (is-eq tx-sender (var-get owner)) ERR_UNAUTHORIZED)
    (print {
      topic: "set-rate",
      old: (var-get ustx-per-sat-scaled),
      new: ustx-per-sat-scaled-value,
    })
    (ok (var-set ustx-per-sat-scaled ustx-per-sat-scaled-value))
  )
)

(define-public (set-owner (new-owner principal))
  (begin
    (asserts! (is-eq tx-sender (var-get owner)) ERR_UNAUTHORIZED)
    (ok (var-set owner new-owner))
  )
)

(define-read-only (get-rate)
  (var-get ustx-per-sat-scaled)
)

(define-read-only (get-scale)
  SCALE
)

(define-read-only (get-owner)
  (var-get owner)
)
