;; title: dex-adapter-jing-juice
;; Swap sBTC -> STX as a taker into Jing's Juice batch auction.
;;
;; This is not an AMM. Makers escrow inventory at a limit price during a
;; deposit window and the cycle clears against a Pyth reference price, so there
;; is no curve and no slippage -- a taker either clears inside its limit or the
;; call reverts. That makes it complementary to the Bitflow adapters rather
;; than a substitute: it can fill size the thin AMM pools cannot (see
;; docs/plan-fastpool-stx-rewards.md section 7), but only when makers happen to
;; be resting on the other side.
;;
;; Verified against the v3 sources at
;; github.com/Rapha-btc/jing-contracts-v3, and against `vault-sbtc-stx-v2.clar`,
;; which is the reference integration for this exact call.
;;
;; MARKET SIDES. `markets-sbtc-stx-jing-v2` holds sBTC as token-x and STX as
;; token-y, so selling sBTC is `deposit-x = true`. Only that direction is
;; implemented here -- this pool has no reason to buy sBTC.
;;
;; FILL OR KILL. The market's `swap` reverts on a partial fill or on nothing
;; filled, rather than resting the remainder as an unwanted maker position. A
;; leg that cannot clear costs a failed transaction and nothing else, and the
;; signer manager's own `min-stx-out` check is a second, independent backstop.
;;
;; THE TAKER REBATE is why the limit price is not simply derived from
;; `amount-sats`. The market withholds `TAKER_REBATE_BPS` of the amount up
;; front and pays it to the filled makers on the other side; only the remainder
;; is actually auctioned. Pricing the limit against the full amount would let a
;; fill land under `min-stx-out`.
;;
;; This contract holds no funds and no state.

(impl-trait .dex-traits.dex-adapter-proof-trait)

;; Mirrors TAKER_REBATE_BPS in the market. If the market's value ever drifts
;; from this one the limit price would be computed against the wrong base --
;; the signer manager's `min-stx-out` assert still catches the result, so the
;; failure is a reverted swap, not a bad fill.
(define-constant TAKER_REBATE_BPS u20)
(define-constant BPS_PRECISION u10000)

;; The market's PRICE_PRECISION (u100000000) * DECIMAL_FACTOR (u100). Its
;; settlement converts sats to micro-STX as `sats * price / PRICE_SCALE`, so a
;; limit price is the inverse of that. Same scaling as Jing's RFQ contract,
;; which is what `contracts/price-oracle-jing.clar` reads.
(define-constant PRICE_SCALE u10000000000)

(define-constant ERR_AMOUNT_TOO_SMALL (err u4001))

(define-public (swap-sbtc-to-stx-with-proof
    (amount-sats uint)
    (min-stx-out uint)
    (proof (buff 8192))
  )
  (let (
      ;; What actually reaches the auction, after the market withholds the
      ;; taker rebate from `amount-sats`.
      (auctioned (- amount-sats (/ (* amount-sats TAKER_REBATE_BPS) BPS_PRECISION)))
    )
    (asserts! (> auctioned u0) ERR_AMOUNT_TOO_SMALL)
    (let (
        ;; Round the limit UP, so integer division can never leave it a hair
        ;; below the price `min-stx-out` actually requires.
        (limit (/ (+ (* min-stx-out PRICE_SCALE) (- auctioned u1)) auctioned))
        )
      (let ((result (try! (contract-call? .markets-sbtc-stx-jing-v2 swap
          ;; The full outlay: the market splits it into rebate + deposit, and
          ;; the two sum to exactly this.
          amount-sats
          ;; The market rejects a zero limit outright, and a zero here would
          ;; mean "fill at any price" anyway -- which is what `min-stx-out` is
          ;; for, not the limit.
          (if (is-eq limit u0)
            u1
            limit
          )
          proof
          'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token "sbtc-token"
          'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2 "wstx"
          ;; deposit-x: selling sBTC.
          true
        ))))
        ;; Informational only -- the signer manager credits stackers from its
        ;; own measured STX balance delta, never from this number.
        (ok (get token-y-received result))
      )
    )
  )
)
