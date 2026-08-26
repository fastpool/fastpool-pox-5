;; title: dex-traits
;; Traits used by `fastpool-stx-rewards` for its sBTC -> STX swap.
;;
;; They live in their own contract so that adapter and oracle implementations
;; can `impl-trait` them without depending on the signer manager itself, and so
;; that the signer manager's own source -- which is charged as `read_length` on
;; every call into it -- does not carry any DEX-specific weight.

;; A thin, stateless translator for one DEX.
;;
;; The signer manager invokes this inside its own `as-contract?`, so `tx-sender`
;; is the signer manager for the whole nested call: the DEX pulls sBTC from
;; `tx-sender` and credits the STX back to `tx-sender` directly. An adapter is
;; therefore never expected to custody either asset.
;;
;; The returned value is informational only. The signer manager credits stakers
;; from its own measured STX balance delta, never from this number.
(define-trait dex-adapter-trait (
  ;; (amount-sats, min-stx-out) -> micro-STX delivered to tx-sender
  (swap-sbtc-to-stx
    (uint uint)
    (response uint uint)
  )
))

;; A baseline price feed, used only as a sanity floor on the operator's
;; `min-stx-out`. It is not a pricing feed: see `docs/plan-fastpool-stx-rewards.md`
;; section 8.
(define-trait price-oracle-trait (
  ;; sats -> micro-STX at the baseline price
  (sats-to-ustx
    (uint)
    (response uint uint)
  )
))
