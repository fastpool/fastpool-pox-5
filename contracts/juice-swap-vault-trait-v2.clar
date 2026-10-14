(define-trait swap-vault-trait (
  (fund
    (uint)
    (response uint uint)
  )
  (finish
    ()
    (response uint uint)
  )
  (emergency-recover
    ()
    (
      response       {
      stx: uint,
      sbtc: uint,
    }
      uint
    )
  )
  (get-upgrade-status
    ()
    (
      response       {
      pool: principal,
      empty: bool,
      sbtc-balance: uint,
      stx-balance: uint,
      batch-start: (optional uint),
      jing-resting: uint,
      jing-parked: uint,
    }
      uint
    )
  )
  (jing-refloor
    ((buff 8192))
    (response uint uint)
  )
  (set-window-blocks
    (uint)
    (response bool uint)
  )
  (set-leeway-bps
    (uint)
    (response bool uint)
  )
  (set-slippage-bps
    (uint)
    (response bool uint)
  )
  (set-max-chunk-sats
    (uint)
    (response bool uint)
  )
  (set-dia-band-bps
    (uint)
    (response bool uint)
  )
  (set-router-cooldown
    (uint)
    (response bool uint)
  )
  (set-no-pyth-slippage-bps
    (uint)
    (response bool uint)
  )
  (set-pyth-fee-budget
    (uint)
    (response bool uint)
  )
  (jing-take
    (uint (buff 8192))
    (
      response       {
      notification: (string-ascii 32),
      payload: {
        amount: uint,
        limit-price: uint,
        out: uint,
      },
    }
      uint
    )
  )
  (router-swap-split
    (uint uint uint uint uint (buff 8192))
    (
      response       {
      notification: (string-ascii 32),
      payload: {
        amount: uint,
        jing: uint,
        dlmm: uint,
        xyk: uint,
        velar: uint,
        limit-price: uint,
        velar-limit: uint,
        mid: uint,
        out: uint,
        unsold: uint,
      },
    }
      uint
    )
  )
  (router-swap-split-dia
    (uint uint uint uint)
    (
      response       {
      notification: (string-ascii 32),
      payload: {
        amount: uint,
        dlmm: uint,
        xyk: uint,
        velar: uint,
        mid: uint,
        limit-price: uint,
        price-source: (string-ascii 6),
        dia-error: (optional uint),
        out: uint,
        unsold: uint,
      },
    }
      uint
    )
  )
))
