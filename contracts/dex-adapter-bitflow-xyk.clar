;; title: dex-adapter-bitflow-xyk
;; Swap sBTC -> STX on Bitflow's standard constant-product (XYK) pool.
;;
;; The sibling of `dex-adapter-bitflow-dlmm`, and the reason both exist: same
;; venue, different curve. Concentrated liquidity gives a better fill up to the
;; edge of its active range and then degrades sharply; the constant-product pool
;; is shallower but degrades smoothly. Splitting a large pot across the two
;; usually beats routing all of it to whichever quotes best at zero size, which
;; is exactly what `swap-rewards` supports by accepting several legs per cycle.
;;
;; Live pool, verified on mainnet:
;;   helper SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-swap-helper-v-1-3
;;   pool   SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1
;;   in     SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
;;   out    SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2
;;
;; `swap-helper-a` is the single-hop form: `xyk-tokens.a` is what is sold and
;; `xyk-tokens.b` what is bought, through the one pool in `xyk-pools.a`.
;;
;; As with the DLMM adapter, `token-stx-v-1-2` is a SIP-010 facade over *native*
;; STX, so the proceeds arrive as real STX and the signer manager's balance
;; delta sees them. This contract holds no funds and no state.

(impl-trait .dex-traits.dex-adapter-trait)

(define-public (swap-sbtc-to-stx
    (amount-sats uint)
    (min-stx-out uint)
  )
  (contract-call? 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-swap-helper-v-1-3
    swap-helper-a
    amount-sats
    min-stx-out
    ;; No referral provider.
    none
    {
      a: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token,
      b: 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2,
    } { a: 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1 }
  )
)
