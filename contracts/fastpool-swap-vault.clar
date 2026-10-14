;; The signer manager dispatches every vault call through
;; 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.juice-swap-vault-trait-v2.swap-vault-trait
;; (signer-manager-vault-stx-rewards.clar:26). Declaring it here makes the
;; compiler prove conformance at check time instead of leaving a signature drift
;; to surface at runtime, after deploy, when the contract can no longer change.
;; The Juice vault has always declared its trait; this closes the gap.
(impl-trait 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.juice-swap-vault-trait-v2.swap-vault-trait)

(define-constant ERR_RECOVERY_TOO_SOON (err u16046))
(define-constant ERR_BUSY (err u16045))
(define-constant ERR_UNAUTHORIZED (err u16000))
(define-constant ERR_NO_FUNDS (err u16006))
(define-constant ERR_INVALID_PRICE (err u16013))
(define-constant ERR_WINDOW_CLOSED (err u16030))
(define-constant ERR_WINDOW_OPEN (err u16031))
(define-constant ERR_NO_CLOCK (err u16032))
(define-constant ERR_ORACLE_DIA (err u16035))
(define-constant ERR_ORACLE_STALE (err u16036))
(define-constant ERR_ORACLE_DIVERGED (err u16037))
(define-constant ERR_NO_BLOCK_TIME (err u16038))
(define-constant ERR_CHUNK_TOO_BIG (err u16039))
(define-constant ERR_SOME_FUNDS (err u16043))
(define-constant ERR_COOLDOWN (err u16044))
(define-constant ERR_BELOW_FLOOR (err u16047))
;; the router lets each leg land up to ROUND_SLACK (2) sats under the limit;
;; four legs at most
(define-constant ROUTER_SLACK_SATS u8)
(define-constant ERR_OUT_OF_RANGE (err u16033))
(define-constant ERR_SPLIT_MISMATCH (err u16040))
(define-constant ERR_UPDATE_REQUIRED (err u16041))

(define-constant PRICE_PRECISION u100000000)
(define-constant DECIMAL_FACTOR u100)
(define-constant BPS_PRECISION u10000)
;; most rebate dust the market (markets-sbtc-stx-jing-v6-3) refunds: under
;; 1 sat per rounding, 1 for net + 1 for the batch share + 49 walk fills.
;; Router v5-3 sizes the book leg at the market's gross-cap, so the leg
;; trades in full and only this rounding comes back.
(define-constant JING_REBATE_DUST_SATS u51)
;; the market's TAKER_REBATE_MAX_BPS (markets-sbtc-stx-jing-v6-3): the stale-feed
;; ceiling of the taker rebate. The rebate on a sub-min rest the market
;; refunds is never spent, so it comes back on top of the rounding dust:
;; rem * bps / 10000 with rem < min-x and bps <= 70.
(define-constant MAX_TAKER_REBATE_BPS u70)

(define-constant POOL .signer-manager-vault-stx-rewards)
(define-constant SBTC_TOKEN 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token)
(define-constant ASSET_SBTC "sbtc-token")
(define-constant WSTX_TOKEN 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2)
(define-constant ASSET_WSTX "wstx")

(define-constant JING_MARKET 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6-3)
(define-constant JING_ROUTER 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.swap-router-sbtc-stx-jing-v5-3)

(define-constant RECOVERY_DELAY_BLOCKS u432)
(define-constant MAX_DIA_AGE u7200)
;; the patience window must close before recovery opens (batch start +
;; RECOVERY_DELAY_BLOCKS, also the pool's own recovery deadline)
(define-constant MAX_WINDOW_BLOCKS u288)
(define-constant MAX_LEEWAY_BPS u1000)
(define-constant MAX_SLIPPAGE_BPS u1000)
(define-constant MAX_DIA_BAND_BPS u5000)
(define-constant MAX_CHUNK_SATS u100000000)

;; sBTC transfers in are permissionless, so anyone can leave a sat or two in the
;; vault. Dust that small cannot be sold - every router stage skips it and the
;; swap returns zero - so an exact-zero emptiness test would let a 1-sat gift
;; hold a batch open until the 432-block recovery. Treat it as empty instead;
;; it simply rides into the next batch.
(define-constant DUST_SATS u2)

(define-constant MAX_COOLDOWN_BLOCKS u144)

(define-constant VELAR_SLIPPAGE_BPS u60)

(define-constant MAX_NO_PYTH_SLIPPAGE_BPS u5000)

(define-data-var no-pyth-slippage-bps uint u1000)

;; Pyth Lazer charges its per-update fee in STX from tx-sender, which is this
;; vault inside `as-contract?`. The fee is u0 today; this is the STX each
;; Lazer-verifying swap may spend, so a later set-fee needs no redeploy.
;; The market's `swap` verifies the update once per call, so a Jing fill costs
;; one fee: set the budget to >= 1x the oracle fee.
(define-constant MAX_PYTH_FEE_BUDGET u10000000) ;; 10 STX
(define-data-var pyth-fee-budget uint u0)

(define-data-var window-blocks uint u288)
(define-data-var leeway-bps uint u500)
(define-data-var slippage-bps uint u100)
(define-data-var max-chunk-sats uint u1000000)
(define-data-var dia-band-bps uint u1000)
(define-data-var router-cooldown-blocks uint u1)
(define-data-var last-router-swap uint u0)
(define-data-var batch-start (optional uint) none)
(define-data-var ready-to-finish bool false)

(define-public (set-no-pyth-slippage-bps (bps uint))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (<= bps MAX_NO_PYTH_SLIPPAGE_BPS) ERR_OUT_OF_RANGE)
    (var-set no-pyth-slippage-bps bps)
    (print {
      notification: "set-no-pyth-slippage-bps",
      payload: { value: bps },
    })
    (ok true)
  )
)

(define-public (set-window-blocks (blocks uint))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)

    (asserts! (is-none (var-get batch-start)) ERR_BUSY)
    (asserts! (<= blocks MAX_WINDOW_BLOCKS) ERR_OUT_OF_RANGE)
    (var-set window-blocks blocks)
    (print {
      notification: "set-window-blocks",
      payload: { value: blocks },
    })
    (ok true)
  )
)

(define-public (set-leeway-bps (bps uint))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (<= bps MAX_LEEWAY_BPS) ERR_OUT_OF_RANGE)
    (var-set leeway-bps bps)
    (print {
      notification: "set-leeway-bps",
      payload: { value: bps },
    })
    (ok true)
  )
)

(define-public (set-slippage-bps (bps uint))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (<= bps MAX_SLIPPAGE_BPS) ERR_OUT_OF_RANGE)
    (var-set slippage-bps bps)
    (print {
      notification: "set-slippage-bps",
      payload: { value: bps },
    })
    (ok true)
  )
)

(define-public (set-max-chunk-sats (sats uint))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (and (> sats u0) (<= sats MAX_CHUNK_SATS)) ERR_OUT_OF_RANGE)
    (var-set max-chunk-sats sats)
    (print {
      notification: "set-max-chunk-sats",
      payload: { value: sats },
    })
    (ok true)
  )
)

(define-public (set-dia-band-bps (bps uint))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (<= bps MAX_DIA_BAND_BPS) ERR_OUT_OF_RANGE)
    (var-set dia-band-bps bps)
    (print {
      notification: "set-dia-band-bps",
      payload: { value: bps },
    })
    (ok true)
  )
)

(define-public (set-router-cooldown (blocks uint))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (<= blocks MAX_COOLDOWN_BLOCKS) ERR_OUT_OF_RANGE)
    (var-set router-cooldown-blocks blocks)
    (print {
      notification: "set-router-cooldown",
      payload: { value: blocks },
    })
    (ok true)
  )
)

(define-public (set-pyth-fee-budget (ustx uint))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (<= ustx MAX_PYTH_FEE_BUDGET) ERR_OUT_OF_RANGE)
    (var-set pyth-fee-budget ustx)
    (print {
      notification: "set-pyth-fee-budget",
      payload: { value: ustx },
    })
    (ok true)
  )
)

(define-public (fund (amount uint))
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (is-none (var-get batch-start)) ERR_BUSY)
    (asserts! (not (var-get ready-to-finish)) ERR_BUSY)
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (try! (contract-call? SBTC_TOKEN transfer amount POOL current-contract none))
    (var-set batch-start (some burn-block-height))
    (print {
      notification: "fund",
      payload: {
        amount: amount,
        batch-start: burn-block-height,
      },
    })
    (ok amount)
  )
)

;; Anyone may close a batch after all sBTC and Jing positions are gone.
;; what this vault has on the market: live + parked + pending escrow
(define-private (market-total)
  (let ((cycle (contract-call? JING_MARKET get-current-cycle)))
    (+ (contract-call? JING_MARKET get-token-x-deposit cycle current-contract)
      (contract-call? JING_MARKET get-token-x-parked current-contract)
      (default-to u0
        (get amount
          (contract-call? JING_MARKET get-token-x-pending-deposit
            current-contract
          ))
      ))
  )
)

;; dust on the market (a 1-sat jing-place after the sell-out) would keep
;; is-empty false until the window ends: when wallet + market is at most
;; DUST_SATS, cancel it home first (no oracle), so the batch closes now
(define-public (close-batch)
  (let ((on-market (market-total)))
    (and
      (> on-market u0)
      (<= (+ on-market (sbtc-balance)) DUST_SATS)
      (is-ok (reclaim-core))
    )
    (asserts! (is-empty) ERR_SOME_FUNDS)
    (asserts! (is-some (var-get batch-start)) ERR_NO_CLOCK)
    (var-set batch-start none)
    (var-set ready-to-finish true)
    (ok (print {
      notification: "close-batch",
      payload: { burn-height: burn-block-height },
    }))
  )
)

(define-public (finish)
  (let ((balance (stx-get-balance current-contract)))
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (var-get ready-to-finish) ERR_NO_CLOCK)
    ;; a dust-only batch (<= DUST_SATS, nothing sold) closes with 0 STX:
    ;; a 0 transfer fails, so skip it (as emergency-recover does)
    (and
      (> balance u0)
      (try! (as-contract? ((with-stx balance))
        (try! (stx-transfer? balance current-contract POOL))
      ))
    )
    (var-set ready-to-finish false)
    (print {
      notification: "finish",
      payload: { amount: balance },
    })
    (ok balance)
  )
)

(define-public (emergency-recover)
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (let (
        (start (unwrap! (var-get batch-start) ERR_NO_CLOCK))
        (cycle (contract-call? JING_MARKET get-current-cycle))
        (escrowed (default-to u0
          (get amount
            (contract-call? JING_MARKET get-token-x-pending-deposit
              current-contract
            ))
        ))
      )
      (asserts! (>= burn-block-height (+ start RECOVERY_DELAY_BLOCKS))
        ERR_RECOVERY_TOO_SOON
      )
      ;; Cancel returns pending escrow + resting + parked in one call, with no
      ;; oracle and no pause check, so recovery never waits on a settle.
      (let (
          (resting (contract-call? JING_MARKET get-token-x-deposit cycle current-contract))
          (parked (contract-call? JING_MARKET get-token-x-parked current-contract))
        )
        (if (or
            (> escrowed u0)
            (> resting u0)
            (> parked u0)
          )
          (begin
            (try! (reclaim-core))
            true
          )
          true
        )
      )
      (let (
          (sbtc (sbtc-balance))
          (stx (stx-get-balance current-contract))
        )
        (if (> sbtc u0)
          (begin
            (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC sbtc))
              (try! (contract-call? SBTC_TOKEN transfer sbtc current-contract POOL none))
            ))
            true
          )
          true
        )
        (if (> stx u0)
          (begin
            (try! (as-contract? ((with-stx stx))
              (try! (stx-transfer? stx current-contract POOL))
            ))
            true
          )
          true
        )
        (asserts! (is-empty) ERR_SOME_FUNDS)
        (var-set batch-start none)
        (var-set ready-to-finish false)
        (print {
          notification: "emergency-recover",
          payload: {
            sbtc: sbtc,
            stx: stx,
          },
        })
        (ok {
          sbtc: sbtc,
          stx: stx,
        })
      )
    )
  )
)

(define-public (jing-place (update (buff 8192)))
  (let (
      (floor (ask-of (try! (current-mid update))))
      (amount (sbtc-balance))
    )
    (asserts! (window-open) ERR_WINDOW_CLOSED)
    (try! (check-amount amount))
    (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC amount))
      (try! (contract-call? JING_MARKET deposit-token-x amount floor (some u0)
        SBTC_TOKEN ASSET_SBTC
      ))
    ))
    (ok (print {
      notification: "jing-place",
      payload: {
        amount: amount,
        floor: floor,
      },
    }))
  )
)

(define-public (jing-reclaim)
  (begin
    (asserts! (window-elapsed) ERR_WINDOW_OPEN)
    (reclaim-core)
  )
)

(define-public (jing-take
    (requested uint)
    (update (buff 8192))
  )
  (let ((amount (sweep-amount requested)))
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (window-elapsed) ERR_WINDOW_OPEN)
    (try! (check-amount amount))
    (let ((limit (floor-of (try! (current-mid update)))))
      (let ((result (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC amount)
            (with-stx (var-get pyth-fee-budget))
          )
          (try! (contract-call? JING_MARKET swap amount limit update SBTC_TOKEN
            ASSET_SBTC WSTX_TOKEN ASSET_WSTX true
          ))
        ))))
        (close-if-empty)
        (ok (print {
          notification: "jing-take",
          payload: {
            amount: amount,
            limit-price: limit,
            out: (get token-y-received result),
          },
        }))
      )
    )
  )
)

(define-public (router-swap (update (buff 8192)))
  (let (
      ;; permissionless: always the whole balance or one full chunk, never a
      ;; caller-chosen sliver that burns the shared cooldown
      (amount (chunk-amount))
      (mid (try! (current-mid update)))
      (limit (floor-of mid))
      (mins (contract-call? JING_MARKET get-min-deposits))
    )
    (asserts! (window-elapsed) ERR_WINDOW_OPEN)
    (try! (check-amount amount))
    (try! (cooldown-tick))
    (let ((result (try! (as-contract?
        ;; the market refunds the unfilled rest (rem < min-x) and the unused
        ;; rebate, and the router re-sells both: allow that on top of `amount`.
        ;; Unused rebate < rem * b + 51.007 (b = bps / 10000 <= 0.007; under
        ;; 1.007 sat from the net rounding, under 1 per floor: batch share plus
        ;; at most 49 walk fills, the bid list holds 50). So rem + unused
        ;; rebate < min-x * (1 + b) + 51.007, an integer, hence
        ;; <= min-x + ceil(min-x * 70 / 10000) + 51.
        ((with-ft SBTC_TOKEN ASSET_SBTC
          (+ amount (get min-token-x mins) JING_REBATE_DUST_SATS
            (/
              (+ (* (get min-token-x mins) MAX_TAKER_REBATE_BPS)
                (- BPS_PRECISION u1)
              )
              BPS_PRECISION
            )
          ))
          (with-stx (var-get pyth-fee-budget))
        )
        (try! (contract-call? JING_ROUTER smart-swap-sbtc-for-stx amount limit
          (some update) mid u0
        ))
      ))))
      ;; sell what fits inside the floor, keep the rest: every router leg
      ;; already enforces the limit, so the floor is checked on what sold
      (let ((sold (- amount (get unsold result))))
        (asserts! (> sold ROUTER_SLACK_SATS) ERR_BELOW_FLOOR)
        (asserts!
          (>= (get out result) (floor-out (- sold ROUTER_SLACK_SATS) limit))
          ERR_BELOW_FLOOR
        )
      )
      (close-if-empty)
      (ok (print {
        notification: "router-swap",
        payload: {
          amount: amount,
          limit-price: limit,
          mid: mid,
          out: (get out result),
          unsold: (get unsold result),
        },
      }))
    )
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
  (let (
      (mid (try! (current-mid update)))
      (limit (floor-of mid))
      (velar-limit (/ (* mid (- BPS_PRECISION VELAR_SLIPPAGE_BPS)) BPS_PRECISION))
      (mins {
        dlmm: (floor-out dlmm limit),
        xyk: (floor-out xyk limit),
        velar: (floor-out velar velar-limit),
      })
      (market-mins (contract-call? JING_MARKET get-min-deposits))
    )
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (is-eq amount (+ jing dlmm xyk velar)) ERR_SPLIT_MISMATCH)
    (asserts! (window-elapsed) ERR_WINDOW_OPEN)
    (asserts! (<= amount (var-get max-chunk-sats)) ERR_CHUNK_TOO_BIG)
    (try! (check-amount amount))
    (try! (cooldown-tick))
    (let ((result (try! (as-contract?
        ((with-ft SBTC_TOKEN ASSET_SBTC (+ amount (get min-token-x market-mins)))
          (with-stx (var-get pyth-fee-budget))
        )
        (try! (contract-call? JING_ROUTER swap-sbtc-for-stx amount jing limit
          (some update) none {
          dlmm: dlmm,
          xyk: xyk,
          velar: velar,
        }
          mins
          (+ (floor-out (+ jing dlmm xyk) limit) (floor-out velar velar-limit))
        ))
      ))))
      (close-if-empty)
      (ok (print {
        notification: "router-swap-split",
        payload: {
          amount: amount,
          jing: jing,
          dlmm: dlmm,
          xyk: xyk,
          velar: velar,
          limit-price: limit,
          velar-limit: velar-limit,
          mid: mid,
          out: (get out result),
          unsold: (get unsold result),
        },
      }))
    )
  )
)

(define-public (router-swap-split-dia
    (amount uint)
    (dlmm uint)
    (xyk uint)
    (velar uint)
  )
  (begin
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (asserts! (is-eq amount (+ dlmm xyk velar)) ERR_SPLIT_MISMATCH)
    (asserts! (window-elapsed) ERR_WINDOW_OPEN)
    (asserts! (<= amount (var-get max-chunk-sats)) ERR_CHUNK_TOO_BIG)
    (try! (check-amount amount))
    (try! (cooldown-tick))
    (let ((price (try! (get-no-pyth-price))))
      (let (
          (limit (get limit price))
          (mins {
            dlmm: (floor-out dlmm limit),
            xyk: (floor-out xyk limit),
            velar: (floor-out velar limit),
          })
        )
        (let ((result (try! (as-contract? ((with-ft SBTC_TOKEN ASSET_SBTC amount))
            (try! (contract-call? JING_ROUTER swap-sbtc-for-stx amount u0 limit none
              none {
              dlmm: dlmm,
              xyk: xyk,
              velar: velar,
            }
              mins (floor-out amount limit)
            ))
          ))))
          (close-if-empty)
          (ok (print {
            notification: "router-swap-split-dia",
            payload: {
              amount: amount,
              dlmm: dlmm,
              xyk: xyk,
              velar: velar,
              mid: (get mid price),
              limit-price: limit,
              price-source: (get source price),
              dia-error: (get dia-error price),
              out: (get out result),
              unsold: (get unsold result),
            },
          }))
        )
      )
    )
  )
)

(define-read-only (get-no-pyth-price)
  (match (get-dia-price)
    mid (let ((limit (/ (* mid (- BPS_PRECISION (var-get no-pyth-slippage-bps))) BPS_PRECISION)))
      (asserts! (> limit u0) ERR_INVALID_PRICE)
      (ok {
        mid: mid,
        limit: limit,
        source: "dia",
        dia-error: none,
      })
    )
    dia-error (let (
        (mid (try! (contract-call?
          'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.rfq-sbtc-stx-jing-v2-3
          get-native-price
        )))
        (limit (/ mid u2))
      )
      (asserts! (> limit u0) ERR_INVALID_PRICE)
      (ok {
        mid: mid,
        limit: limit,
        source: "native",
        dia-error: (some dia-error),
      })
    )
  )
)

(define-read-only (get-dia-value (key (string-ascii 32)))
  (let (
      (res (unwrap!
        (contract-call? 'SP1G48FZ4Y7JY8G2Z0N51QTCYGBQ6F4J43J77BQC0.dia-oracle
          get-value key
        )
        ERR_ORACLE_DIA
      ))
      (last-time (unwrap! (get-stacks-block-info? time (- stacks-block-height u1))
        ERR_NO_BLOCK_TIME
      ))
      (ts (/ (get timestamp res) u1000))
      (v (get value res))
    )
    (asserts! (> v u0) ERR_INVALID_PRICE)
    (asserts! (>= (+ ts MAX_DIA_AGE) last-time) ERR_ORACLE_STALE)
    (ok v)
  )
)

(define-read-only (get-dia-price)
  (let (
      (stx-usd (try! (get-dia-value "STX/USD")))
      (btc-usd (try! (get-dia-value "BTC/USD")))
      (price (/ (* btc-usd PRICE_PRECISION) stx-usd))
    )
    (asserts! (> price u0) ERR_INVALID_PRICE)
    (ok price)
  )
)

(define-read-only (window-open)
  (match (var-get batch-start)
    s (< burn-block-height (+ s (var-get window-blocks)))
    false
  )
)

(define-read-only (window-elapsed)
  (match (var-get batch-start)
    s (>= burn-block-height (+ s (var-get window-blocks)))
    false
  )
)

;; The amount a single-venue swap actually sells.
;;
;; A keeper sizes the final chunk from the balance it read a block earlier, so a
;; sat donated in between leaves a remainder that keeps the batch open and forces
;; a retry at the griefer's chosen pace. Once the whole balance fits in one chunk
;; there is no reason to sell less than all of it, so sweep: the donation goes out
;; with the funds and `close-if-empty` lands on zero in the same transaction.
;;
;; Above the cap the requested chunk is honoured unchanged - that is a mid-run
;; slice, and sweeping it would breach `max-chunk-sats`.
;;
;; Split swaps are deliberately excluded: their amount must equal the sum of the
;; per-venue legs, and there is no way to say which venue the extra dust belongs
;; to.
(define-private (sweep-amount (amount uint))
  (let ((balance (sbtc-balance)))
    (if (<= balance (var-get max-chunk-sats))
      balance
      amount
    )
  )
)

;; what a permissionless router-swap sells: the whole balance, or one full
;; chunk when the balance is bigger
(define-private (chunk-amount)
  (let (
      (balance (sbtc-balance))
      (chunk (var-get max-chunk-sats))
    )
    (if (<= balance chunk)
      balance
      chunk
    )
  )
)

(define-private (sbtc-balance)
  (unwrap-panic (contract-call? 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
    get-balance current-contract
  ))
)

(define-private (current-mid (update (buff 8192)))
  (let (
      (mid (try! (contract-call? JING_MARKET refresh-mid update)))
      (band (var-get dia-band-bps))
    )
    (asserts! (> mid u0) ERR_INVALID_PRICE)
    (if (> band u0)
      (let ((dia (try! (get-dia-price))))
        (asserts! (>= (* mid BPS_PRECISION) (* dia (- BPS_PRECISION band)))
          ERR_ORACLE_DIVERGED
        )
        (asserts! (<= (* mid BPS_PRECISION) (* dia (+ BPS_PRECISION band)))
          ERR_ORACLE_DIVERGED
        )
        (ok mid)
      )
      (ok mid)
    )
  )
)

(define-private (ask-of (mid uint))
  (/ (* mid (- BPS_PRECISION (var-get leeway-bps))) BPS_PRECISION)
)

(define-private (floor-of (mid uint))
  (/ (* mid (- BPS_PRECISION (var-get slippage-bps))) BPS_PRECISION)
)

(define-private (floor-out
    (amount uint)
    (limit uint)
  )
  (/ (* amount limit) (* PRICE_PRECISION DECIMAL_FACTOR))
)

(define-private (cooldown-tick)
  (begin
    (asserts!
      (>= burn-block-height
        (+ (var-get last-router-swap) (var-get router-cooldown-blocks))
      )
      ERR_COOLDOWN
    )
    (ok (var-set last-router-swap burn-block-height))
  )
)

(define-private (check-amount (amount uint))
  (begin
    (asserts! (> amount u0) ERR_NO_FUNDS)
    (asserts! (<= amount (sbtc-balance)) ERR_NO_FUNDS)
    (ok true)
  )
)

(define-private (reclaim-core)
  (let ((refunded (try! (as-contract? ()
      (try! (contract-call? JING_MARKET cancel-token-x-deposit SBTC_TOKEN ASSET_SBTC))
    ))))
    (ok (print {
      notification: "jing-reclaim",
      payload: { amount: refunded },
    }))
  )
)

(define-read-only (get-clock)
  (let ((start (var-get batch-start)))
    {
      batch-start: start,
      ready-to-finish: (var-get ready-to-finish),
      window-ends: (match start
        s (some (+ s (var-get window-blocks)))
        none
      ),
      window-open: (window-open),
      window-elapsed: (window-elapsed),
      burn-height: burn-block-height,
    }
  )
)

;; Once an exit empties the batch, later donations belong to the next batch.
(define-private (close-if-empty)
  (if (is-empty)
    (begin
      (var-set batch-start none)
      (var-set ready-to-finish true)
    )
    false
  )
)

(define-read-only (is-empty)
  (let ((cycle (contract-call?
      'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6-3
      get-current-cycle
    )))
    (and
      (<= (sbtc-balance) DUST_SATS)
      (is-eq
        (contract-call?
          'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6-3
          get-token-x-deposit cycle current-contract
        )
        u0
      )
      (is-eq
        (contract-call?
          'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6-3
          get-token-x-parked current-contract
        )
        u0
      )
      (is-none (contract-call?
        'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6-3
        get-token-x-pending-deposit current-contract
      ))
    )
  )
)

(define-public (jing-refloor (update (buff 8192)))
  (let (
      (mid (try! (current-mid update)))
      (floor (if (window-open)
        (ask-of mid)
        (floor-of mid)
      ))
    )
    (asserts! (is-eq contract-caller POOL) ERR_UNAUTHORIZED)
    (try! (as-contract? ()
      (try! (contract-call? JING_MARKET set-token-x-limit floor (some u0)))
    ))
    (print {
      notification: "jing-refloor",
      payload: { floor: floor },
    })
    (ok floor)
  )
)

(define-read-only (get-config)
  {
    pool: POOL,
    recovery-delay-blocks: RECOVERY_DELAY_BLOCKS,
    window-blocks: (var-get window-blocks),
    leeway-bps: (var-get leeway-bps),
    slippage-bps: (var-get slippage-bps),
    no-pyth-slippage-bps: (var-get no-pyth-slippage-bps),
    max-chunk-sats: (var-get max-chunk-sats),
    dia-band-bps: (var-get dia-band-bps),
    router-cooldown-blocks: (var-get router-cooldown-blocks),
    pyth-fee-budget: (var-get pyth-fee-budget),
    last-router-swap: (var-get last-router-swap),
    market: JING_MARKET,
    router: JING_ROUTER,
  }
)

(define-read-only (get-upgrade-status)
  (let ((cycle (contract-call?
      'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6-3
      get-current-cycle
    )))
    (ok {
      pool: POOL,
      empty: (is-empty),
      sbtc-balance: (sbtc-balance),
      stx-balance: (stx-get-balance current-contract),
      batch-start: (var-get batch-start),
      jing-resting: (contract-call?
        'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6-3
        get-token-x-deposit cycle current-contract
      ),
      jing-parked: (contract-call?
        'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22.markets-sbtc-stx-jing-v6-3
        get-token-x-parked current-contract
      ),
    })
  )
)
