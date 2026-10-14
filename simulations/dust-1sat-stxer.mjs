// Settles Sonic Mast F-1 (AIBTC bounty mu7uxokh9445cb1126bb) on a mainnet fork.
//
// Two questions, both disputed in the submissions:
//
//   1. Can 1 sat actually be sold? Sonic said no, via ERR_MIN_OUT. Reading the
//      router says no for a different reason: limit-min subtracts ROUND_SLACK
//      (u2) before pricing, so a 1-2 sat leg prices at zero and every stage
//      skips it -- no error, just a no-op. At 3 sats the subtraction leaves 1,
//      which prices well above the dust threshold and sells normally.
//
//   2. Does a donated sat hold a batch open? The old is-empty tested the
//      balance for exact zero, so yes. The fix tests `<= DUST_SATS`, where
//      DUST_SATS is deliberately the router's own ROUND_SLACK.
//
// All three vaults route through swap-router-sbtc-stx-jing-v5-3, so the router
// half is proven once and applies to Juice, FastPool and ccd016 alike. The
// vault half deploys the fixed source beside an unfixed copy and compares.
// The current Jing stack (core-v6, ladder-v1, market v6-3, router v5-3) is
// deployed first from jing-contracts-v3 (JING_SRC), as in dust-vaults.
//
// Run: node simulations/dust-1sat-stxer.mjs
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let require = createRequire(resolve(workspace, 'fastpool-pox-5/package.json'));
try { require.resolve('stxer'); }
catch { require = createRequire(resolve(workspace, 'stacking-juice/stx-juice/package.json')); }
const { SimulationBuilder, getSimulationResult } = require('stxer');
const { Cl, ClarityVersion, deserializeCV, cvToString } = require('@stacks/transactions');

import { appendJingStack, freshProofAfter, ROUTER, SBTC, DEP, FORK_BLOCK } from './_jing-v6-3.mjs';
const NODE = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
const API = process.env.STXER_API_URL || 'https://api.stxer.xyz';
const PRICE_SCALE = 10_000_000_000n;

const VAULT_SRC = resolve(workspace, 'fastpool-pox-5/contracts/fastpool-swap-vault.clar');

async function nativeMid() {
  const res = await fetch(
    `https://api.hiro.so/v2/contracts/call-read/${DEP}/rfq-sbtc-stx-jing-v2-3/get-native-price`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: DEP, arguments: [] }), signal: AbortSignal.timeout(30000) });
  const j = await res.json();
  if (!j.okay) throw new Error('native price unavailable');
  return BigInt('0x' + j.result.replace(/^0x07010*/, '').padStart(2, '0'));
}


const mid = await nativeMid();
// Deliberately generous: accept 10% worse than mid, so nothing fails on price.
const limit = (mid * 9000n) / 10000n;
console.log(`native mid ${mid} (${Number(mid) / 1e10} uSTX per sat), limit ${limit}`);
console.log(`ROUND_SLACK arithmetic: 1 sat -> ${(0n * limit) / PRICE_SCALE}, 3 sats -> ${(1n * limit) / PRICE_SCALE}`);

const tipRes = await fetch(`${NODE}/extended/v1/block?limit=1`, { signal: AbortSignal.timeout(20000) });
const tip = (await tipRes.json()).results[0];
const forkHeight = FORK_BLOCK ?? tip.height;
const proof = await freshProofAfter(tip.block_time);
const update = Cl.buffer(Buffer.from(proof.hex.replace(/^0x/, ''), 'hex'));

// The fixed vault, and the same source with the fix backed out.
const fixed = readFileSync(VAULT_SRC, 'utf8');
if (!fixed.includes('DUST_SATS')) throw new Error('vault source lacks the fix; nothing to compare');
const unfixed = fixed.replace('(<= (sbtc-balance) DUST_SATS)', '(is-eq (sbtc-balance) u0)');
if (unfixed === fixed) throw new Error('could not back the fix out');

const builder = SimulationBuilder.new({ stacksNodeAPI: NODE, apiEndpoint: API })
  .useBlockHeight(forkHeight).withSender(DEP);
const plan = [];
const sourceHashes = {};
appendJingStack(builder, plan, sourceHashes);
const deploy = (name, src) => {
  builder.addContractDeploy({ contract_name: name, source_code: src, clarity_version: ClarityVersion.Clarity6 });
  plan.push({ label: `deploy ${name}`, kind: 'deploy' });
};
const call = (label, id, fn, args, want, sender = DEP) => {
  builder.addContractCall({ contract_id: id, function_name: fn, function_args: args, sender });
  plan.push({ label, kind: 'tx', want });
};
const ev = (label, id, code, want) => { builder.addEvalCode(id, code); plan.push({ label, kind: 'eval', want }); };

// --- part 1: what the router does with dust, on real mainnet liquidity -------
const swap = (sats) => [Cl.uint(sats), Cl.uint(limit), Cl.some(update), Cl.uint(mid), Cl.uint(0)];
// How small is too small? The submissions assumed ROUND_SLACK (u2) was the
// floor; walk the ladder on real liquidity and let the router answer.
for (const sats of [1, 2, 3, 10, 100, 1000, 10000]) {
  call(`${sats} sat(s): does the router actually sell it?`, ROUTER, 'smart-swap-sbtc-for-stx', swap(sats),
    v => v.startsWith('(ok'));
}

// --- part 2: what a donated sat does to each vault's emptiness test ----------
deploy('dust-vault-unfixed', unfixed);
deploy('dust-vault-fixed', fixed);
const unfixedId = `${DEP}.dust-vault-unfixed`, fixedId = `${DEP}.dust-vault-fixed`;
ev('unfixed vault starts empty', unfixedId, '(is-empty)', 'true');
ev('fixed vault starts empty', fixedId, '(is-empty)', 'true');
call('donate 1 sat to the unfixed vault', SBTC, 'transfer',
  [Cl.uint(1), Cl.principal(DEP), Cl.contractPrincipal(DEP, 'dust-vault-unfixed'), Cl.none()], v => v.startsWith('(ok'));
call('donate 1 sat to the fixed vault', SBTC, 'transfer',
  [Cl.uint(1), Cl.principal(DEP), Cl.contractPrincipal(DEP, 'dust-vault-fixed'), Cl.none()], v => v.startsWith('(ok'));
ev('UNFIXED: 1 sat makes it look non-empty, so the batch cannot close', unfixedId, '(is-empty)', 'false');
ev('FIXED: 1 sat is tolerated, the batch can close', fixedId, '(is-empty)', 'true');

console.log(`submitting ${plan.length} steps at mainnet block ${forkHeight}`);
const id = await builder.run();
console.log(`View: https://stxer.xyz/simulations/mainnet/${id}`);
const result = await getSimulationResult(id, { stxerApi: API });

let pass = 0;
const lines = plan.map((p, i) => {
  const step = result.steps[i]?.Result;
  let hex = null;
  if (step?.Eval?.Ok) hex = step.Eval.Ok;
  else if (step?.Transaction?.Ok?.result) hex = step.Transaction.Ok.result;
  let actual;
  try { actual = hex ? cvToString(deserializeCV(Buffer.from(hex, 'hex'))) : JSON.stringify(step ?? null); }
  catch { actual = hex ?? JSON.stringify(step ?? null); }
  const ok = p.kind === 'deploy' ? !!result.steps[i]
    : typeof p.want === 'function' ? p.want(actual) : actual === p.want;
  if (ok) pass++;
  return `${ok ? 'PASS' : 'FAIL'}  ${p.label}\n        ${actual}`;
});
console.log(lines.join('\n'));
console.log(`\n${pass}/${plan.length} checks passed`);
const out = resolve(dirname(fileURLToPath(import.meta.url)), 'results/dust-1sat');
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'result.txt'), `simulation ${id}\n\n${lines.join('\n')}\n\n${pass}/${plan.length}\n`);
process.exit(pass === plan.length ? 0 : 1);
