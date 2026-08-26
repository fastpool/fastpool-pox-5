;; title: price-oracle-jing
;; The miner-commit baseline price, read from Jing's RFQ contract.
;;
;; This is the real implementation of the baseline described in
;; docs/plan-fastpool-stx-rewards.md section 8, and it replaces `price-oracle-dummy`
;; on mainnet.
;;
;; WHAT IT MEASURES
;;
;; `SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.rfq-sbtc-stx-jing-v2-3` derives an
;; STX/BTC price from what miners actually pay to win a tenure:
;;
;;     price = 100 * coinbase-ustx * PRICE_PRECISION / avg(miner-spend-total)
;;
;; sampling `miner-spend-total` over recent tenures via Clarity's
;; `get-tenure-info?`. Miners bid sats and are paid the STX coinbase, so the
;; ratio is a native, on-chain, expensive-to-manipulate estimate of STX priced
;; in BTC -- exactly the property wanted from a floor that bounds a compromised
;; operator key. Nothing here is fed from off chain.
;;
;; THE CONVERSION
;;
;; Jing's own `fix-price` converts a sats amount to micro-STX as
;; `sats * price / (PRICE_PRECISION * DECIMAL_FACTOR)`, i.e. `/ 1e10`. This
;; contract does the same, so the floor the signer manager enforces is
;; denominated the same way Jing denominates its own price band.
;;
;; CALIBRATION -- READ THIS BEFORE SETTING `max-slippage-bips`
;;
;; The baseline is NOT spot. Measured together on mainnet:
;;
;;     miner-commit baseline   3632 uSTX/sat
;;     Bitflow XYK near-spot   2883 uSTX/sat   (-20.6% vs baseline)
;;
;; Miners bid on expected value, so the commit-implied price runs above the
;; market here. A swap filling at true spot is already ~21% under this baseline,
;; which means a `max-slippage-bips` of 2000 (20%) would reject even a perfect
;; swap. Set the tolerance wide enough to clear that gap -- see
;; docs/deploy-stx-rewards.md section 6 -- and re-check it periodically, because the
;; gap moves with the market.
;;
;; FAILURE MODE
;;
;; `get-native-price` returns an error when it has no usable tenure samples.
;; That propagates, which fails `swap-rewards` closed: no baseline, no swap.
;; That is the right direction to fail, but it does mean a chain state with no
;; samples stalls swapping until the 3-day window expires and the pot pays out
;; as sBTC.

(impl-trait .dex-traits.price-oracle-trait)

;; PRICE_PRECISION (u100000000) * DECIMAL_FACTOR (u100) in the Jing contract.
;; Kept as one constant because it is only ever used as the pair.
(define-constant PRICE_SCALE u10000000000)

(define-read-only (sats-to-ustx (sats uint))
  (ok
    (/
      (* sats
        (try! (contract-call?
          'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.rfq-sbtc-stx-jing-v2-3
          get-native-price
        ))
      )
      PRICE_SCALE
    ))
)

;; The raw baseline, for the keeper and for anyone auditing a swap after the
;; fact: micro-STX per satoshi, scaled by `PRICE_SCALE`.
(define-read-only (get-native-price)
  (contract-call?
    'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.rfq-sbtc-stx-jing-v2-3
    get-native-price
  )
)

;; The coinbase Jing is assuming, in micro-STX. Currently 1000 STX. If Stacks
;; ever changes emission, this moves and the baseline moves with it.
(define-read-only (get-coinbase-ustx)
  (contract-call?
    'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.rfq-sbtc-stx-jing-v2-3
    get-coinbase-ustx
  )
)
