;; title: dex-adapter-bitflow-dlmm
;; Swap sBTC -> STX on Bitflow's DLMM (concentrated-liquidity) pool.
;;
;; Everything about the venue is a literal here: the router, the pool, and both
;; tokens. That is deliberate -- the adapter allowlist in `fastpool-stx-rewards-signer-manager`
;; then authorizes one specific pool, and the operator has no parameter with
;; which to redirect a swap somewhere else.
;;
;; Live pool, verified on mainnet:
;;   router SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2
;;   pool   SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-2-bps-15
;;   x      SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2
;;   y      SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
;;
;; The pool holds STX as x and sBTC as y, so selling sBTC is the `y-for-x`
;; direction.
;;
;; `token-stx-v-1-2` is a SIP-010 facade over *native* STX, not a wrapped
;; balance: a swap through it emits real STX transfer events. That is what makes
;; the signer manager's native `stx-get-balance` delta the correct measure of
;; what came back.
;;
;; This adapter holds no funds and no state. The signer manager calls it inside
;; its own `as-contract?`, so `tx-sender` is the signer manager for the whole
;; nested call: the pool pulls sBTC from it and sends the STX straight back to
;; it, without this contract ever touching either asset.

(impl-trait .dex-traits.dex-adapter-trait)

;; How far the router may walk across liquidity bins to fill the order. DLMM
;; liquidity is concentrated, so a large order has to step through several bins;
;; too low a cap makes a swap that a wider one would have filled revert. 230 is
;; what Bitflow's own front end uses in production.
(define-constant MAX_STEPS u230)

(define-public (swap-sbtc-to-stx
    (amount-sats uint)
    (min-stx-out uint)
  )
  (let ((result (try! (contract-call?
      'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-swap-router-v-1-2
      swap-y-for-x-simple-range-multi
      'SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-sbtc-v-2-bps-15
      'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2
      'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
      amount-sats
      min-stx-out
      MAX_STEPS
      ;; No deadline: the signer manager's swap is a single atomic transaction,
      ;; and its own `min-stx-out` check is the real protection.
      none
    ))))
    ;; Informational only -- the signer manager credits stackers from its own
    ;; measured STX balance delta, never from this number.
    (ok (get out result))
  )
)
