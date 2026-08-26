# Deploying `fastpool-stx-rewards-signer-manager`

The suite is five contracts. This is the order to publish them, the wiring they
need before they can run a cycle, and the checks to run at each step.

Design rationale lives in [plan-fastpool-stx-rewards.md](plan-fastpool-stx-rewards.md).

---

## 1. What gets deployed where

| contract | testnet | mainnet | why |
| --- | --- | --- | --- |
| `dex-traits` | yes | yes | trait definitions |
| `fastpool-stx-rewards-signer-manager` | yes | yes | the signer manager |
| `price-oracle-dummy` | yes | **no** | admin-set rate; testnet/test stand-in |
| `price-oracle-jing` | **no** | yes | production baseline: miner commits |
| `dex-adapter-bitflow-dlmm` | **no** | yes | hard-codes live mainnet pools |
| `dex-adapter-bitflow-xyk` | **no** | yes | hard-codes live mainnet pools |
| `mock-dex-adapter` | test only | **never** | test fixture |

The adapters name mainnet routers and pools as literals, and `price-oracle-jing`
names Jing's mainnet RFQ contract. None of those exist on a test chain, so
publishing them there fails analysis. On testnet the mock adapter and the dummy
oracle stand in. `scripts/deploy.mjs` enforces this split — it prints what it is
skipping and why.

## 2. The pox-5 principal

`contracts/` is written against the **testnet** boot address
`ST000000000000000000002AMW42H.pox-5`, because that is what the vendored boot
copy and the simnet tests use. Mainnet has the same contract at
`SP000000000000000000002Q6VF78.pox-5`. **Publishing the testnet-addressed source
to mainnet fails analysis** — the implemented trait would not resolve.

```bash
node scripts/build-mainnet.mjs        # contracts/ -> build/mainnet/, one substitution
```

It refuses to finish if any output still mentions the testnet address, and it
regenerates `deployments/stx-rewards.mainnet-plan.yaml`. Diff `build/mainnet`
against `contracts/` before applying; the only difference should be that
principal (9 occurrences, all in the signer manager).

sBTC and the DEX principals need no rewriting — they are already mainnet, which
is exactly what lets `clarinet check` type-check the adapters against the real
routers.

## 3. Pre-flight

```bash
clarinet check          # must be 0 errors; warnings are check_checker lint
npx vitest run tests/stx-rewards.test.ts
npx vitest run tests/bench-distribute-many.test.ts -- --costs
```

The `clarinet check` is doing real work for the adapters: every argument in
`dex-adapter-*.clar` is a literal checked against the live mainnet ABI, so a
transposed argument or a wrong token is a compile error here rather than an
incident later.

## 4. Publish

```bash
# testnet / private node — manager, traits, oracle; adapters skipped
./scripts/deploy-testnet.sh

# mainnet
node scripts/build-mainnet.mjs
clarinet deployments apply -p deployments/stx-rewards.mainnet-plan.yaml
```

Publish order is `dex-traits` → `fastpool-stx-rewards-signer-manager` → `price-oracle-dummy` →
the two adapters. The plan already encodes it, one batch per contract.

## 5. Wiring — the contract does nothing useful until this is done

Every call here is admin-only, from the deployer (seeded as the first admin).

```
1. update-fees             <bips>            pool fee, in sBTC, e.g. u400 = 4%
2. set-price-oracle        <oracle>          .price-oracle-jing   (mainnet)
3. (set-max-slippage-bips / set-enforce-price-floor -- LEAVE ALONE; see §6)
4. set-dex-adapter         <dlmm> true
5. set-dex-adapter         <xyk>  true
6. set-operator            <keeper address>  the hot key that runs swaps
7. register-self           <self> <signer-key> <auth-id> <signer-sig>
```

On testnet, step 2 points at `.price-oracle-dummy` and step 3 is preceded by
`price-oracle-dummy set-rate <µSTX per sat × 1e8>`.

`register-self` is the same signer-key grant flow the other managers use;
`node scripts/bootstrap.mjs register` builds the SIP-018 signature.

Verify with the read-onlys before letting anyone stake:

```
get-operator            -> the keeper, not the deployer
get-price-oracle        -> .price-oracle-jing
is-dex-adapter          -> true for both adapters
get-enforce-price-floor -> false  (the baseline is informational at launch)
get-fees-bips           -> your chosen value
```

And sanity-check the oracle itself before anyone stakes:

```
price-oracle-jing  get-native-price     -> (ok <n>), not an error
price-oracle-jing  sats-to-ustx u100000 -> compare against a live DEX quote
```

## 6. The slippage floor — the default is WRONG, raise it

The oracle is a **sanity floor on the operator's `min-stx-out`**, not a price
feed. It exists so a compromised operator key cannot set `min-stx-out` to 1 and
hand the pot to a sandwich.

On mainnet the baseline comes from `price-oracle-jing`, which reads miner
commitments (`get-tenure-info? miner-spend-total`) through Jing's RFQ contract.
Nothing is fed from off chain and there is no rate to set.

**But the baseline is not spot, and it runs high.** Measured together:

| source | µSTX/sat |
| --- | --- |
| miner-commit baseline | 3632 |
| Bitflow XYK near-spot | 2883 |
| Bitflow aggregate, 0.4 sBTC | 1857 |

Spot is already **20.6% below** the baseline. So with the shipped default of
`max-slippage-bips = u2000` (20%), **a swap filling at a perfect market price
would be rejected** with `ERR_MIN_OUT_TOO_LOW`. The suite will look broken.

Raise it before the first swap. The tolerance has to cover:

```
(baseline - spot)/baseline      ~21% today, and it moves
  + the price impact of a leg   see §7
  + the keeper's own haircut    SLIPPAGE_BIPS, default 1%
```

A starting point of `u3500`–`u4000` clears today's gap with room for a sized
leg. Re-measure `get-native-price` against a live quote periodically — this gap
is a market observation, not a constant.

**It also interacts with leg sizing, deliberately.** See §7: a leg large enough
to move the pool past the tolerance is refused. That is the floor doing its job
— split the leg.

On testnet, `price-oracle-dummy set-rate` takes µSTX per satoshi scaled by 1e8
(`2883 * 1e8 = 288_300_000_000`), and none of the above applies.

## 7. Liquidity is thin. Size the legs accordingly.

Measured on the live Bitflow XYK sBTC/STX pool:

| leg size | µSTX per sat | vs near-spot |
| --- | --- | --- |
| 0.001 sBTC | 2883 | — |
| 0.010 sBTC | 2830 | −1.8% |
| 0.050 sBTC | 2615 | −9.3% |
| 0.100 sBTC | 2389 | −17% |
| 0.400 sBTC | 1572 | **−45%** |

A whole cycle's pot pushed through one venue in one transaction would be a
disaster. This is why `swap-rewards` accepts **many legs per cycle**, across
venues, and why the window is three days rather than three blocks: legs can be
spread across venues *and* across time.

Operator guidance: keep a leg under ~0.02–0.05 sBTC on XYK, quote both venues
before each leg, and let the 3-day window absorb a large pot rather than forcing
it through at once. Bitflow's aggregate quote for 0.4 sBTC was ~1857 µSTX/sat
against XYK-alone's 1572, so the DLMM pool carries materially more depth —
quote it, do not assume.

## 8. First cycle, with a deliberately small swap

Do not let the first live cycle be the first time the adapter path executes.
`clarinet check` proves the call shape; only mainnet proves the pool behaves.

```bash
REWARD_CYCLE=<n> node scripts/stx-rewards.mjs status
REWARD_CYCLE=<n> node scripts/stx-rewards.mjs claim
REWARD_CYCLE=<n> node scripts/stx-rewards.mjs mirror     # repair if it says MISMATCH
REWARD_CYCLE=<n> node scripts/stx-rewards.mjs pin
REWARD_CYCLE=<n> node scripts/stx-rewards.mjs quote

# a token first leg -- 0.001 sBTC -- to prove the adapter end to end
REWARD_CYCLE=<n> VENUE=xyk AMOUNT_SATS=100000 node scripts/stx-rewards.mjs swap

REWARD_CYCLE=<n> node scripts/stx-rewards.mjs status      # stx-out went up?
# then the rest, in sized legs, then:
REWARD_CYCLE=<n> node scripts/stx-rewards.mjs distribute
```

`claim`, `mirror`, `repair`, `pin` and `distribute` are permissionless. Only
`swap` needs the operator key.

## 9. Operational watch items

- **The 3-day window.** If the operator does not swap, the pot pays out as sBTC
  and stackers do not get what they came for. Alert at half the window
  (~216 burn blocks after the claim), not at the deadline.
- **Mirror drift is normal.** A stacker who unstakes mid-lock leaves the mirror
  high for cycles that were future at the time. `pin` fails, `repair` fixes it.
  This is expected, not an incident.
- **Rotate the operator** with `set-operator` the moment the keeper key is
  suspect. It takes effect immediately and the old key loses `swap-rewards`
  and nothing else — no other function is affected.
- **Dust accrues and stays.** Floor-division remainders are reserved inside the
  liability counters and are not sweepable by design. Under one µSTX and one
  satoshi per stacker per cycle.

## 10. Known gaps at first deploy

- **ALEX is not supported.** ALEX has no sBTC/STX pool — its pools are on
  wrapped tokens (`token-wstx`, `token-abtc`, `token-wbtc`). Routing there would
  mean a multi-hop through a bridged BTC, a different asset with different risk.
  Not built; needs a product decision first.
- **Velar is not supported.** Bitflow's router reports a Velar sBTC/STX route,
  but the Velar contract could not be identified from chain data, so no adapter
  was written. Adding one is a self-contained ~30-line contract once the
  router's principal and ABI are confirmed.
- **Jing's RFQ is not a swap venue here, and cannot be.** A contract cannot be
  an RFQ client: `fix-price` requires a signature that recovers to the client
  principal, and a contract has no key. Its `get-native-price` is used as the
  oracle instead. See plan section 7.
- **`validate-stake!`'s bond refusal is untested.** Driving a real bond through
  pox-5 needs a bond-period fixture the test suite does not have. The guard is a
  single `asserts!` and is statically obvious, but it has not been executed.
