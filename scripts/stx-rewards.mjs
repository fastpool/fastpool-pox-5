#!/usr/bin/env node
//
// Operator/keeper driver for `fastpool-stx-rewards`.
//
// One cycle, start to finish:
//
//   REWARD_CYCLE=42 node scripts/stx-rewards.mjs status      # read-only: where the cycle stands
//   REWARD_CYCLE=42 node scripts/stx-rewards.mjs claim       # pox-5 -> the contract (sBTC). Starts the 3-day window.
//   REWARD_CYCLE=42 node scripts/stx-rewards.mjs mirror      # read-only: does the share mirror match pox-5?
//   REWARD_CYCLE=42 node scripts/stx-rewards.mjs repair      # only if `mirror` says no
//   REWARD_CYCLE=42 node scripts/stx-rewards.mjs pin         # freeze the pro-rata denominator
//   REWARD_CYCLE=42 node scripts/stx-rewards.mjs quote       # read-only: what the venues are paying
//   REWARD_CYCLE=42 VENUE=xyk AMOUNT_SATS=... node scripts/stx-rewards.mjs swap
//   REWARD_CYCLE=42 node scripts/stx-rewards.mjs distribute  # pay everyone, in batches of 300
//
// `claim`, `mirror`, `repair`, `pin` and `distribute` are permissionless --
// anyone can run them. Only `swap` needs the operator key, because it is the
// only call that sets a price. See docs/plan-fastpool-stx-rewards.md §13.
//
// THE STACKER LIST comes from the contract's own `validate-stake` print events,
// read back from the API. That is the only piece of state the contract does not
// hold in a form this script can enumerate on chain, and it is why `repair` and
// `distribute` need an API rather than just a node.
//
// Env:
//   NETWORK          profile name; default private-1 (see scripts/_network.mjs)
//   API_URL          overrides the profile's node URL
//   CHAIN_ID         overrides the chain id auto-detected from /v2/info
//   FEE              default 100000 uSTX per call
//   CONTRACT         default <deployerAddr>.fastpool-stx-rewards
//   OPERATOR_KEY     hex key for `swap` (else mnemonic account 0)
//   DEPLOYER_KEY     hex key for everything else (else mnemonic account 0)
//   REWARD_CYCLE     the cycle to act on (required for every subcommand)
//   For `swap`:
//   VENUE            `xyk` | `dlmm`   (default xyk)
//   AMOUNT_SATS      how much of the pot to put through this leg (default: all of it)
//   SLIPPAGE_BIPS    haircut applied to the quote to get min-stx-out (default 100 = 1%)
//   MIN_STX_OUT      set it explicitly and skip quoting entirely
//   ADAPTER/ORACLE   override the adapter / oracle principals
//   For `distribute`:
//   BATCH            stackers per transaction (default 300, the contract's bound)
//   DRY_RUN=1        print what would be sent, broadcast nothing

import {
  Cl, cvToValue, hexToCV, makeContractCall, broadcastTransaction,
  getAddressFromPrivateKey, fetchCallReadOnlyFunction,
} from '@stacks/transactions';
import { STACKS_TESTNET } from '@stacks/network';
import { resolveDeployerKey, resolveKeyAtIndex } from './_wallet.mjs';
import { resolveNetwork } from './_network.mjs';

const target = await resolveNetwork();
const API_URL = target.apiUrl;
const CHAIN_ID = BigInt(target.chainId);
const FEE = BigInt(process.env.FEE ?? '100000');
const client = { baseUrl: API_URL };
const net = { network: { ...STACKS_TESTNET, chainId: Number(CHAIN_ID) }, client };

// The contract's own bound on `distribute-rewards-many`. Raising it here
// without raising it in the contract just makes every call fail.
const CONTRACT_BATCH_MAX = 300;

const bail = (msg) => { console.error(msg); process.exit(1); };
const cycle = () => {
  const c = process.env.REWARD_CYCLE;
  if (!c) bail('missing env REWARD_CYCLE');
  return BigInt(c);
};

const deployerKey = await resolveDeployerKey();
const deployerAddr = getAddressFromPrivateKey(deployerKey, 'testnet');
const CONTRACT = process.env.CONTRACT ?? `${deployerAddr}.fastpool-stx-rewards`;
const [addr, name] = CONTRACT.split('.');

// Venues. Each `adapter` is one of contracts/dex-adapter-*.clar, deployed
// alongside the signer manager and allowlisted by an admin.
const VENUES = {
  xyk: {
    adapter: process.env.ADAPTER ?? `${deployerAddr}.dex-adapter-bitflow-xyk`,
    // Bitflow's XYK helper exposes an on-chain quote, so this venue can be
    // priced exactly, with no external API in the loop.
    quote: {
      contract: 'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-swap-helper-v-1-3',
      fn: 'get-quote-a',
    },
  },
  dlmm: {
    adapter: process.env.ADAPTER ?? `${deployerAddr}.dex-adapter-bitflow-dlmm`,
    // The DLMM router publishes no on-chain quote. Rather than pull in an
    // external price API, the keeper prices this venue off the XYK quote and
    // lets `min-stx-out` do the enforcing: DLMM should fill at least as well,
    // and if it does not the swap reverts having moved nothing.
    quote: null,
  },
};

async function readOnly(contractId, fn, args, sender = deployerAddr) {
  const [a, n] = contractId.split('.');
  return fetchCallReadOnlyFunction({
    contractAddress: a, contractName: n, functionName: fn,
    functionArgs: args, senderAddress: sender, ...net,
  });
}

async function send(txOpts, label) {
  if (process.env.DRY_RUN) {
    console.log(`[dry-run] ${label}: ${txOpts.functionName}(${(txOpts.functionArgs ?? []).length} args)`);
    return null;
  }
  const tx = await makeContractCall({ fee: FEE, ...txOpts, ...net });
  const res = await broadcastTransaction({ transaction: tx, ...net });
  if (res.error) bail(`${label} FAILED: ${JSON.stringify(res)}`);
  console.log(`${label} broadcast: txid 0x${res.txid}`);
  console.log(`  ${API_URL.replace('api.', 'explorer.')}/txid/0x${res.txid}`);
  return res.txid;
}

const call = (fn, args, key = deployerKey) =>
  send({
    contractAddress: addr, contractName: name, functionName: fn,
    functionArgs: args, senderKey: key, postConditionMode: 'allow',
  }, fn);

// `cvToValue` unwraps only the outer tuple; each field is still {type, value}.
const flat = (cv) => Object.fromEntries(
  Object.entries(cvToValue(cv, true)).map(([k, v]) => [k, v?.value ?? v]),
);

async function swapStatus() {
  const s = flat(await readOnly(CONTRACT, 'get-swap-status', [Cl.uint(cycle())]));
  return {
    potSats: BigInt(s['pot-sats']),
    swappedSats: BigInt(s['swapped-sats']),
    remainingSats: BigInt(s['remaining-sats']),
    feeSats: BigInt(s['fee-sats']),
    stxOut: BigInt(s['stx-out']),
    totalShares: BigInt(s['total-shares']),
    deadline: BigInt(s.deadline),
    pinned: s.pinned === true,
    windowOpen: s['window-open'] === true,
  };
}

async function burnHeight() {
  const r = await fetch(`${API_URL}/v2/info`).then((x) => x.json());
  return BigInt(r.burn_block_height);
}

// Stackers as pox-5 sees them: the authoritative list for a cycle, read from
// the manager's own `validate-stake` events.
async function stackersFromEvents() {
  const found = new Set();
  for (let offset = 0; offset < 4000; offset += 100) {
    const url = `${API_URL}/extended/v1/contract/${CONTRACT}/events?limit=100&offset=${offset}`;
    const page = await fetch(url).then((x) => x.json()).catch(() => null);
    const results = page?.results ?? [];
    if (!results.length) break;
    for (const e of results) {
      const hex = e?.contract_log?.value?.hex;
      if (!hex) continue;
      try {
        const v = cvToValue(hexToCV(hex), true);
        if (v?.topic?.value === 'validate-stake' && v?.stacker?.value) found.add(v.stacker.value);
      } catch { /* not our print */ }
    }
  }
  return [...found];
}

const cmds = {
  async status() {
    const s = await swapStatus();
    const bh = await burnHeight();
    console.log(`cycle ${cycle()} on ${CONTRACT}`);
    console.log(`  pot            ${s.potSats} sats`);
    console.log(`  swapped        ${s.swappedSats} sats  (fees ${s.feeSats})`);
    console.log(`  remaining      ${s.remainingSats} sats`);
    console.log(`  stx received   ${s.stxOut} uSTX`);
    console.log(`  shares pinned  ${s.pinned}  (denominator ${s.totalShares})`);
    console.log(`  swap window    ${s.windowOpen ? 'OPEN' : 'CLOSED'}  deadline burn ht ${s.deadline}, now ${bh}`);
    if (s.windowOpen) {
      const left = s.deadline - bh;
      console.log(`                 ${left} burn blocks left (~${(Number(left) / 144).toFixed(1)} days)`);
    } else if (s.remainingSats > 0n) {
      console.log('  NOTE: the window closed with the pot unswapped -- it now pays out as sBTC.');
    }
    console.log(`  contract-wide  unswapped ${await one('get-unswapped-sats')} sats, unpaid ${await one('get-unpaid-stx')} uSTX, fees ${await one('get-earned-fees')} sats`);
  },

  async mirror() {
    const m = flat(await readOnly(CONTRACT, 'check-mirror', [Cl.uint(cycle())]));
    const local = BigInt(m.local), remote = BigInt(m['pox-5']);
    console.log(`local ${local}  pox-5 ${remote}  ${m.matches === true ? 'MATCH' : 'MISMATCH'}`);
    if (m.matches !== true) {
      console.log(`  mirror is high by ${local - remote} uSTX -- run \`repair\`, then \`pin\`.`);
      console.log('  (expected after a stacker unstakes mid-lock; see plan §3)');
    }
  },

  async repair() {
    const stackers = await stackersFromEvents();
    if (!stackers.length) bail('no stackers found in contract events');
    console.log(`repairing ${stackers.length} stackers for cycle ${cycle()}`);
    // Each entry costs a pox-5 call, so the contract bounds this list at 100.
    for (let i = 0; i < stackers.length; i += 100) {
      const batch = stackers.slice(i, i + 100);
      await call('repair-mirror-many', [
        Cl.list(batch.map((s) => Cl.principal(s))), Cl.uint(cycle()),
      ]);
    }
  },

  async pin() {
    await call('pin-shares', [Cl.uint(cycle())]);
  },

  async quote() {
    const s = await swapStatus();
    const amount = process.env.AMOUNT_SATS ? BigInt(process.env.AMOUNT_SATS) : s.remainingSats;
    if (amount === 0n) bail('nothing left to swap for this cycle');
    const q = await quoteXyk(amount);
    console.log(`${amount} sats ->`);
    console.log(`  xyk   ${q} uSTX  (${perSat(q, amount)} uSTX/sat, on-chain quote)`);
    console.log('  dlmm  no on-chain quote; priced off the xyk number, min-out enforces the rest');

    // The miner-commit baseline. Informational unless an admin has switched the
    // floor on -- printed here so the gap to the market can be watched over
    // time, which is what `max-slippage-bips` should eventually be set from.
    const base = await baselineFor(amount);
    if (base === null) {
      console.log('  base  oracle could not price this right now');
    } else {
      const gap = Number(q - base) / Number(base) * 100;
      console.log(`  base  ${base} uSTX  (${perSat(base, amount)} uSTX/sat, miner-commit)`);
      console.log(`        market is ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}% vs baseline`);
    }
    const enforced = await one('get-enforce-price-floor');
    console.log(`  floor ${enforced === true ? `ENFORCED at ${await one('get-max-slippage-bips')} bips` : 'not enforced (informational only)'}`);

    const bips = BigInt(process.env.SLIPPAGE_BIPS ?? '100');
    console.log(`  min-stx-out at ${bips} bips slippage: ${(q * (10000n - bips)) / 10000n}`);
  },

  async swap() {
    const venueName = process.env.VENUE ?? 'xyk';
    const venue = VENUES[venueName];
    if (!venue) bail(`unknown VENUE ${venueName}; expected one of ${Object.keys(VENUES).join(', ')}`);

    const s = await swapStatus();
    if (!s.windowOpen) bail(`the swap window for cycle ${cycle()} has closed; the pot now pays out as sBTC`);
    const amount = process.env.AMOUNT_SATS ? BigInt(process.env.AMOUNT_SATS) : s.remainingSats;
    if (amount === 0n) bail('nothing left to swap for this cycle');
    if (amount > s.remainingSats) bail(`only ${s.remainingSats} sats left to swap`);

    let minOut;
    if (process.env.MIN_STX_OUT) {
      minOut = BigInt(process.env.MIN_STX_OUT);
    } else {
      // Quote the NET, not the gross: the contract takes its fee in sBTC first
      // and only the remainder reaches the DEX.
      const feeBips = BigInt(cvToValue(await readOnly(CONTRACT, 'get-fee-bips-for-cycle', [Cl.uint(cycle())]), true));
      const net = amount - (amount * feeBips) / 10000n;
      const bips = BigInt(process.env.SLIPPAGE_BIPS ?? '100');
      minOut = (await quoteXyk(net) * (10000n - bips)) / 10000n;
      console.log(`quote for ${net} net sats -> min-stx-out ${minOut} (${bips} bips haircut)`);
    }

    const operatorKey = (process.env.OPERATOR_KEY ?? deployerKey).replace(/^0x/, '');
    const oracle = process.env.ORACLE ?? `${deployerAddr}.price-oracle-dummy`;
    const [aAddr, aName] = venue.adapter.split('.');
    const [oAddr, oName] = oracle.split('.');
    console.log(`swap ${amount} sats on ${venueName} (${venue.adapter}) min-out ${minOut}`);
    await call('swap-rewards', [
      Cl.uint(cycle()),
      Cl.contractPrincipal(aAddr, aName),
      Cl.contractPrincipal(oAddr, oName),
      Cl.uint(amount),
      Cl.uint(minOut),
    ], operatorKey);
  },

  async distribute() {
    const s = await swapStatus();
    if (!s.pinned) bail('shares are not pinned yet -- run `pin` first');
    if (s.windowOpen && s.remainingSats > 0n) {
      console.log(`WARNING: ${s.remainingSats} sats are still unswapped and the window is open.`);
      console.log('  Distributing now pays only the STX leg; the rest waits for a swap or the deadline.');
    }
    const batch = Math.min(Number(process.env.BATCH ?? CONTRACT_BATCH_MAX), CONTRACT_BATCH_MAX);
    const stackers = await stackersFromEvents();
    if (!stackers.length) bail('no stackers found in contract events');
    console.log(`distributing to ${stackers.length} stackers in batches of ${batch}`);
    for (let i = 0; i < stackers.length; i += batch) {
      const chunk = stackers.slice(i, i + batch);
      await call('distribute-rewards-many', [
        Cl.list(chunk.map((x) => Cl.principal(x))), Cl.uint(cycle()),
      ]);
    }
  },

  async claim() {
    await call('claim-rewards', [Cl.uint(cycle())]);
  },
};

async function quoteXyk(amountSats) {
  const { contract, fn } = VENUES.xyk.quote;
  const cv = await readOnly(contract, fn, [
    Cl.uint(amountSats),
    Cl.none(),
    Cl.tuple({
      a: Cl.principal('SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token'),
      b: Cl.principal('SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2'),
    }),
    Cl.tuple({ a: Cl.principal('SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1') }),
  ]);
  const v = cvToValue(cv, true);
  if (v?.value === undefined) bail(`quote failed: ${JSON.stringify(v)}`);
  return BigInt(v.value);
}

const one = async (fn) => cvToValue(await readOnly(CONTRACT, fn, []), true);

const perSat = (ustx, sats) => (Number(ustx) / Number(sats)).toFixed(1);

// What the pinned oracle says `sats` is worth, or null if it cannot say.
async function baselineFor(sats) {
  const oracle = process.env.ORACLE ?? cvToValue(await readOnly(CONTRACT, 'get-price-oracle', []), true);
  try {
    const cv = await readOnly(String(oracle), 'sats-to-ustx', [Cl.uint(sats)]);
    const v = cvToValue(cv, true);
    return v?.value === undefined ? null : BigInt(v.value);
  } catch {
    return null;
  }
}

const cmd = process.argv[2];
if (!cmd || !cmds[cmd]) {
  console.error(`usage: node scripts/stx-rewards.mjs <${Object.keys(cmds).join('|')}>`);
  process.exit(1);
}
await cmds[cmd]();
