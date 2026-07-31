# fastpool-pox-5

The **FAST Pool signer manager** for pox-5, covering the **STX-only** stacking leg.

In pox-5 a "signer" is a *contract* implementing `signer-manager-trait`.
`contracts/fastpool-signer-manager.clar` is that contract. Stakers lock STX-only
against it via pox-5's `stake` / `stake-update`; pox-5 calls back into
`validate-stake!` to authorize the staker. pox-5 rewards are paid in **sBTC**,
which the signer manager claims (`claim-rewards`) and distributes
(`claim-staker-rewards`, `claim-staker-rewards-many`, `distribute-rewards-many`).

sBTC contracts are pulled from mainnet via Clarinet `requirements` — no mocks.

## Why pox-5 is vendored

The contract targets the **canonical** pox-5 (per-staker reward model: read-only
`get-earned-staker-rewards`, `claim-staker-rewards-for-signer`). The pox-5 that
the Clarinet CLI ships is a divergent *signer-pot* model the contract does not
type-check against — `clarinet check` fails on it with
`expecting read-only statements, detected a writing operation`.

So the canonical source is vendored at `boot/pox-5.clar` and pinned via
`[project.override_boot_contracts_source]` in `Clarinet.toml`. This makes both
`clarinet check` and the simnet tests run against the same known pox-5 instead
of whichever one the installed toolchain happens to bundle.

## Run it

```bash
pnpm install
clarinet check   # warnings are check_checker lint; 0 errors expected
pnpm test
```

## Testnet

### Which network

The scripts take a `NETWORK` profile (see `scripts/_network.mjs`):

| `NETWORK` | node | chain id | pox-5? |
| --- | --- | --- | --- |
| `private-1` *(default)* | `api.private-1.hiro.so` | 256 | yes — stacks-node 4.x |
| `testnet` | `api.testnet.hiro.so` | 2147483648 | **no** — see below |

> **The public Hiro testnet cannot host these contracts today.** It runs
> stacks-node 3.4.x, whose PoX contract is `pox-4`;
> `ST000000000000000000002AMW42H.pox-5` does not exist there, so
> `(impl-trait '…pox-5.signer-manager-trait)` fails analysis at publish time.
> Its sBTC deployment (`ST1F7QA2…`) is also missing `sbtc-withdrawal`, which the
> L1 `pox-addr` payout path needs. The profile is wired up so that
> `NETWORK=testnet` works the day testnet ships pox-5; until then every script
> refuses it at preflight with those two contracts named.

The chain id is **read from the target node's `/v2/info`**, not assumed — a
wrong chain id otherwise surfaces only as an opaque post-broadcast
SignatureValidation "invalid chain ID". Override with `CHAIN_ID` if needed.

### Deploying

Clarinet hard-codes testnet as 2147483648 with no override, so
`clarinet deployments apply` is rejected by the private node.
`deployments/default.testnet-plan.yaml` is therefore descriptive only — deploy
with the scripts instead:

```bash
./scripts/deploy-testnet.sh                   # private-1 (default)
NETWORK=testnet ./scripts/deploy-testnet.sh   # refused at preflight, for now
```

Preflight verifies pox-5 and the sBTC suite exist on the target chain before
spending a faucet call or broadcasting. `SKIP_PREFLIGHT=1` downgrades it to a
warning.

`scripts/deploy.mjs` rewrites principals at publish time: the mainnet sBTC suite
(`SM3VDXK3…`) is remapped to the target chain's sBTC (`SN3R84…` on private-1),
and boot pox-5 to `ST000000000000000000002AMW42H`. Both already exist on the
node, so they are remapped, never republished.

Keys come from `settings/Testnet.toml` (gitignored) — account 0 is the deployer,
1 the signer, 2+ the stakers. Override with `DEPLOYER_KEY` / `DEPLOYER_MNEMONIC`.

Then drive the pool:

```bash
node scripts/bootstrap.mjs register        # register the signer with pox-5
node scripts/bootstrap.mjs fund-staker     # stacking faucet -> staker account
node scripts/bootstrap.mjs stake           # lock STX through the signer manager
node scripts/bootstrap.mjs staker-info     # read-only: balances + pox-5 state
FEES_BIPS=450 node scripts/bootstrap.mjs set-fees
REWARD_CYCLE=29 node scripts/bootstrap.mjs claim-rewards
REWARD_CYCLE=29 node scripts/bootstrap.mjs claim-staker-rewards
node scripts/bootstrap.mjs unstake         # unlocks next cycle
```

`scripts/claim-and-unstake.mjs` is an autonomous driver: it polls the node and
crystallizes + claims rewards for `TARGET_CYCLES` as each cycle completes, then
unstakes. `node scripts/bootstrap.mjs auto-extend` rolls the lock over
cycle-to-cycle (pox-5 has no native auto-extend).

The signer manager defaults to `<deployer>.fastpool-signer-manager`; override
with `SIGNER_MANAGER`. See the header comment in each script for the full env list.

## Replaying an on-chain transaction

`scripts/tx-to-deployment.mjs` turns a txid into a deployment plan that re-sends
the same contract call, argument for argument (the arguments are the API's
Clarity `repr` of the on-chain hex):

```bash
pnpm deployment:from-tx 0x1c75d450…f31e     # -> deployments/replay-1c75d450.mainnet-plan.yaml
node scripts/tx-to-deployment.mjs <txid> --out deployments/<name>.mainnet-plan.yaml --fee 100000
```

Meant for a batch that aborted (fee too low, balance too low, a post-condition)
and has to go out again unchanged. The network comes from the sender's address
version, the API from `API_URL` (default `https://api.hiro.so`), and the keys
from the gitignored `settings/Mainnet.toml` at apply time:

```bash
clarinet deployments apply -d --no-dashboard -p deployments/<name>.mainnet-plan.yaml
```

Three things a replay cannot carry over — each written into the generated
plan's header, so read it before applying:

- **sponsorship** — clarinet pays with the sender's own key, so a sponsored tx
  becomes self-paid. The fee defaults to `max(original, 100000)` uSTX.
- **post-conditions** — clarinet uses post-condition mode `allow`; the originals
  are reproduced as comments only.
- **the nonce** — the original is spent; clarinet takes the sender's next one.

When the sender's own STX post-conditions say how much the call moves, the
script compares that against the sender's current balance and puts a funding
warning in the header (and on stdout) if it is short.

`deployments/replay-payout-cycle-139-nonce-905.mainnet-plan.yaml` is the worked
example: the cycle-139 `send-many` batch of 193 recipients that aborted with
`(err u1)` because the payout account was ~5,419 STX short.
