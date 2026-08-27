#!/usr/bin/env node
/**
 * Build a Clarinet deployment plan that pays out one reward cycle for a set of
 * pox-5 signer-manager contracts.
 *
 * The whole point of the script is that `claim-staker-rewards` is not always
 * the right call. In the v2 contract a payout to a Bitcoin address is gated on
 * the staker's own `min-claim`, and only the staker may go under it -- a
 * third-party sender broadcasting this plan cannot. A staker below that floor
 * has to be *settled* instead, which credits their pending balance without
 * moving sBTC, so the balance can accumulate across cycles until some later
 * `payout` clears the floor. Emitting `claim-staker-rewards` for them would
 * abort with ERR_BELOW_MIN_CLAIM (u1013) and burn the fee for nothing.
 *
 * So each staker is read off chain and sorted into one of three buckets:
 *
 *   claim    `claim-staker-rewards` -- settle and pay out in one transaction.
 *   settle   `settle-staker-rewards` -- credit only, payout left for later.
 *   skip     nothing can be emitted; the reason is reported.
 *
 * The v1 contract (fastpool-1) has no `settle-staker-rewards` and no
 * `min-claim`: `claim-staker-rewards` is its only path, and a staker whose
 * reward cannot clear their `max-fee` plus the sBTC dust limit is skipped
 * rather than settled, because on v1 there is nothing to accumulate into.
 * Which contract is which is read from the on-chain ABI, not hardcoded.
 *
 * Usage:
 *   node scripts/build-claim-plan.mjs [options] [contract-id ...]
 *
 *     --cycle N       reward cycle (default: pox-5's current cycle)
 *     --sender ADDR   expected-sender for every transaction; it only pays fees,
 *                     since all of these calls are permissionless
 *     --out PATH      where to write the plan (default: deployments/
 *                     claim-rewards-cycle-<N>.mainnet-plan.yaml)
 *     --per-batch N   transactions per batch, i.e. per block (default 25)
 *     --fee-claim N   fee in uSTX for claim-rewards (default 25000)
 *     --fee-staker N  fee in uSTX for a per-staker call (default 15000)
 *     --dry-run       print the summary, write nothing
 *
 *   Contract ids default to Fast Pool Max500 and Fast Pool v1.
 *
 * Reads STACKS_API_URL (default https://api.hiro.so) and HIRO_API_KEY, which
 * is sent as `x-api-key` when set. Without a key the node rate-limits hard and
 * the script paces itself accordingly -- a few hundred stakers takes minutes.
 */

import { writeFileSync } from 'node:fs';
import { Cl, hexToCV } from '@stacks/transactions';

const POX = 'SP000000000000000000002Q6VF78.pox-5';
const SBTC_DUST_LIMIT = 546n;

const DEFAULT_SIGNERS = [
  'SPMPMA1V6P430M8C91QS1G9XJ95S59JS1TZFZ4Q4.fastpool-max500-signer-manager',
  'SP21YTSM60CAY6D011EZVEVNKXVW8FVZE198XEFFP.fastpool-1-signer-manager',
];

// ---------------------------------------------------------------------------
// The node

const API = (process.env.STACKS_API_URL ?? 'https://api.hiro.so').replace(/\/$/, '');
const API_KEY = process.env.HIRO_API_KEY ?? '';
// An identified caller gets a far higher ceiling; an anonymous one has to
// crawl or every other read comes back 429.
const SPACING_MS = API_KEY ? 50 : 350;

const headers = { 'Content-Type': 'application/json' };
if (API_KEY) headers['x-api-key'] = API_KEY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(path, init) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, { ...init, headers });
    if (res.status === 429 && attempt < 8) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}`);
    return res.json();
  }
}

/** Call a read-only function and return the raw Clarity value. */
async function readOnly(contractId, fn, args = []) {
  const [address, name] = contractId.split('.');
  const body = JSON.stringify({
    sender: address,
    arguments: args.map((a) => Cl.serialize(a)),
  });
  const out = await request(`/v2/contracts/call-read/${address}/${name}/${fn}`, {
    method: 'POST',
    body,
  });
  await sleep(SPACING_MS);
  if (!out.okay) throw new Error(`${contractId}.${fn} failed: ${out.cause}`);
  return hexToCV(out.result);
}

/** A `uint` response as a bigint. */
const uint = (cv) => cv.value;

/** A field of a tuple response, as a bigint. */
const field = (cv, name) => cv.value[name].value;

/** An `(optional (tuple ...))` response as a plain object, or null for `none`. */
const optionalTuple = (cv, names) =>
  cv.type === 'none'
    ? null
    : Object.fromEntries(names.map((n) => [n, field(cv.value, n)]));

async function contractFunctions(contractId) {
  const [address, name] = contractId.split('.');
  const iface = await request(`/v2/contracts/interface/${address}/${name}`);
  await sleep(SPACING_MS);
  return new Set(iface.functions.map((f) => f.name));
}

/**
 * Everyone the API has ever seen stake with this signer *contract*. It carries
 * no amounts and no claim that any of them is still there, which is why every
 * one of them is then asked about on chain.
 */
async function fetchStakers(contractId) {
  const seen = [];
  let cursor = null;
  for (;;) {
    const q = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const page = await request(
      `/extended/v3/staking/signers/${contractId}/stakers?limit=200${q}`,
    );
    await sleep(SPACING_MS);
    seen.push(...page.results.map((r) => r.staker));
    cursor = page.cursor?.next ?? null;
    if (!cursor) return seen;
  }
}

// ---------------------------------------------------------------------------
// What to emit for one staker

/**
 * Decide between claim, settle and skip. `caps` is the contract's function set,
 * which is what distinguishes a v2 contract (settle/payout split, `min-claim`)
 * from v1 (one-shot claim, no floor to accumulate against).
 */
function decide({ caps, earned, pending, config, maxFee }) {
  if (earned === 0n) {
    return { action: 'skip', why: 'no rewards earned this cycle' };
  }

  // v1: `claim-staker-rewards` is the only path, so it has to succeed as-is.
  if (!caps.has('settle-staker-rewards')) {
    if (maxFee === null) return { action: 'claim', why: 'direct sBTC payout' };
    if (earned < maxFee) {
      return {
        action: 'skip',
        why: `L1 payout of ${earned} does not cover max-fee ${maxFee}; v1 cannot accumulate`,
      };
    }
    if (earned - maxFee <= SBTC_DUST_LIMIT) {
      return {
        action: 'skip',
        why: `L1 payout of ${earned - maxFee} after max-fee is at or below dust; v1 cannot accumulate`,
      };
    }
    return { action: 'claim', why: 'L1 payout clears max-fee and dust' };
  }

  // v2. `payout` drains the WHOLE pending balance, so earlier settled cycles
  // count towards the floor alongside this one.
  const total = pending + earned;

  if (config === null) {
    // No payout config: sBTC goes straight to the staker and the only gate is
    // `amount > 0`, which `earned > 0` already established.
    return { action: 'claim', why: 'direct sBTC payout, no min-claim floor' };
  }
  if (total < config.minClaim) {
    return {
      action: 'settle',
      why: `pending ${pending} + earned ${earned} = ${total} below min-claim ${config.minClaim}`,
    };
  }
  if (total <= config.maxFee + SBTC_DUST_LIMIT) {
    // `check-payout-config` makes min-claim exceed this, so reaching here means
    // a config that predates that check. Settling is still the safe answer.
    return {
      action: 'settle',
      why: `total ${total} at or below max-fee ${config.maxFee} + dust`,
    };
  }
  return { action: 'claim', why: `total ${total} clears min-claim ${config.minClaim}` };
}

// ---------------------------------------------------------------------------
// Reading one signer

async function inspectSigner(contractId, cycle) {
  const caps = await contractFunctions(contractId);
  const isV2 = caps.has('settle-staker-rewards');

  // Rewards pox-5 still holds for this signer. `claim-rewards` is what pulls
  // them in and credits the cycle reserve every staker call then draws on, so
  // it has to lead the plan -- but only if there is anything left to pull.
  const pending = uint(
    await readOnly(POX, 'get-signer-unclaimed-rewards-for-cycle', [
      Cl.principal(contractId),
      Cl.uint(cycle),
      Cl.none(),
    ]),
  );

  const stakers = await fetchStakers(contractId);
  const rows = [];

  for (const staker of stakers) {
    const earned = field(
      await readOnly(contractId, 'get-earned-staker-rewards', [
        Cl.principal(staker),
        Cl.uint(cycle),
        Cl.none(),
      ]),
      'earned',
    );

    let pendingPayout = 0n;
    let config = null;
    let maxFee = null;

    if (earned > 0n && isV2) {
      pendingPayout = uint(
        await readOnly(contractId, 'get-pending-payout', [Cl.principal(staker)]),
      );
      const raw = optionalTuple(
        await readOnly(contractId, 'get-payout-config', [Cl.principal(staker)]),
        ['max-fee', 'min-claim'],
      );
      if (raw !== null) config = { maxFee: raw['max-fee'], minClaim: raw['min-claim'] };
    } else if (earned > 0n) {
      const raw = optionalTuple(
        await readOnly(contractId, 'get-pox-addr', [Cl.principal(staker)]),
        ['max-fee'],
      );
      if (raw !== null) maxFee = raw['max-fee'];
    }

    const verdict = decide({ caps, earned, pending: pendingPayout, config, maxFee });
    rows.push({ staker, earned, ...verdict });
  }

  return { contractId, isV2, claimRewardsNeeded: pending > 0n, poxPending: pending, rows };
}

// ---------------------------------------------------------------------------
// Emitting the plan

const call = (contractId, sender, method, parameters, cost) => [
  '    - transaction-type: contract-call',
  `      contract-id: ${contractId}`,
  `      expected-sender: ${sender}`,
  `      method: ${method}`,
  '      parameters:',
  ...parameters.map((p) => `      - ${p}`),
  `      cost: ${cost}`,
  '      anchor-block-only: true',
];

function renderPlan({ signers, cycle, sender, perBatch, feeClaim, feeStaker, totalFee, out }) {
  const lines = [];
  const emit = (...l) => lines.push(...l);

  emit(
    `# Pay out reward cycle ${cycle} for ${signers.length} pox-5 signer-manager contract(s).`,
    '#',
    '# GENERATED by scripts/build-claim-plan.mjs -- regenerate rather than edit.',
    '# Which call each staker gets was decided against chain state at generation',
    '# time; a stake, an unstake or a payout-config change since then can make an',
    '# entry wrong, so regenerate if this has been sitting around.',
    '#',
    '# Apply with:',
    '#     clarinet deployments apply --mainnet \\',
    `#       -p ${out} --no-dashboard`,
    '#',
    '# `claim-rewards` leads, because it credits the per-cycle reserve that every',
    "# staker call then draws on. It is emitted only for signers pox-5 still owes.",
    '#',
    '# `settle-staker-rewards` appears for a staker whose payout would be refused:',
    '# on the v2 contract a third party cannot force an L1 payout below the',
    "# staker's own `min-claim`. Settling credits them without moving sBTC, so the",
    '# balance accumulates until some later `payout` clears the floor.',
    '#',
    '# `bond-periods` is `(list)` and `bond-index` is `none`: pox-5 holds no',
    '# protocol bonds, so this is STX staking only and there is no bond leg.',
    '#',
    `# Every call here is permissionless -- ${sender} only pays`,
    `# fees, about ${(Number(totalFee) / 1e6).toFixed(2)} STX in total.`,
    'id: 0',
    `name: Pay out cycle ${cycle} rewards`,
    'network: mainnet',
    'stacks-node: https://api.hiro.so',
    'bitcoin-node: http://blockstack:blockstacksystem@bitcoin.blockstack.com:8332',
    'plan:',
    '  batches:',
  );

  let batch = 0;
  const leading = signers.filter((s) => s.claimRewardsNeeded);
  if (leading.length > 0) {
    emit(`  - id: ${batch}`, '    transactions:');
    for (const s of leading) {
      emit(...call(s.contractId, sender, 'claim-rewards', ['(list)', `u${cycle}`], feeClaim));
    }
    emit("    epoch: '4.0'");
    batch += 1;
  }

  for (const signer of signers) {
    const name = signer.contractId.split('.')[1];
    for (const method of ['settle-staker-rewards', 'claim-staker-rewards']) {
      const want = method === 'claim-staker-rewards' ? 'claim' : 'settle';
      const rows = signer.rows.filter((r) => r.action === want);
      for (let i = 0; i < rows.length; i += perBatch) {
        const chunk = rows.slice(i, i + perBatch);
        emit(
          `  # ${name}: ${method} ${i + 1}-${i + chunk.length} of ${rows.length}`,
          `  - id: ${batch}`,
          '    transactions:',
        );
        for (const row of chunk) {
          emit(
            ...call(
              signer.contractId,
              sender,
              method,
              [`"'${row.staker}"`, `u${cycle}`, 'none'],
              feeStaker,
            ),
          );
        }
        emit("    epoch: '4.0'");
        batch += 1;
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

const outPath = (cycle) => `deployments/claim-rewards-cycle-${cycle}.mainnet-plan.yaml`;

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    cycle: null,
    sender: 'SPFCGF789WX1B737VQYAQ6BG3QYVMJGPDKRKYK00',
    out: null,
    perBatch: 25,
    feeClaim: 25000,
    feeStaker: 15000,
    dryRun: false,
    signers: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === '--cycle') opts.cycle = Number(next());
    else if (arg === '--sender') opts.sender = next();
    else if (arg === '--out') opts.out = next();
    else if (arg === '--per-batch') opts.perBatch = Number(next());
    else if (arg === '--fee-claim') opts.feeClaim = Number(next());
    else if (arg === '--fee-staker') opts.feeStaker = Number(next());
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else opts.signers.push(arg);
  }
  if (opts.signers.length === 0) opts.signers = DEFAULT_SIGNERS;
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cycle =
    opts.cycle ?? Number(uint(await readOnly(POX, 'current-pox-reward-cycle', [])));
  const out = opts.out ?? outPath(cycle);

  console.error(`node ${API}${API_KEY ? ' (identified)' : ' (anonymous, pacing reads)'}`);
  console.error(`cycle ${cycle}\n`);

  const signers = [];
  for (const contractId of opts.signers) {
    console.error(`reading ${contractId} ...`);
    const signer = await inspectSigner(contractId, cycle);
    signers.push(signer);

    const count = (a) => signer.rows.filter((r) => r.action === a).length;
    console.error(
      `  ${signer.isV2 ? 'v2' : 'v1'}, ${signer.rows.length} stakers: ` +
        `${count('claim')} claim, ${count('settle')} settle, ${count('skip')} skip`,
    );
    if (signer.claimRewardsNeeded) {
      console.error(`  pox-5 still owes ${signer.poxPending} sats -- claim-rewards emitted`);
    } else {
      console.error('  rewards already crystallized -- no claim-rewards');
    }
    for (const row of signer.rows.filter((r) => r.action !== 'claim')) {
      console.error(`  ${row.action.padEnd(6)} ${row.staker}  ${row.why}`);
    }
    console.error('');
  }

  const claims = signers.reduce(
    (n, s) => n + s.rows.filter((r) => r.action !== 'skip').length,
    0,
  );
  const leading = signers.filter((s) => s.claimRewardsNeeded).length;
  const totalFee = BigInt(leading) * BigInt(opts.feeClaim) + BigInt(claims) * BigInt(opts.feeStaker);

  const yaml = renderPlan({ ...opts, signers, cycle, totalFee, out });

  if (opts.dryRun) {
    console.error(`dry run: ${leading + claims} transactions, ~${(Number(totalFee) / 1e6).toFixed(2)} STX in fees`);
    return;
  }
  writeFileSync(out, yaml);
  console.error(
    `wrote ${out}: ${leading + claims} transactions, ~${(Number(totalFee) / 1e6).toFixed(2)} STX in fees`,
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
