// Can the router actually sell a few sats? Two passes, because the mid is only
// available from a transaction (markets-sbtc-stx-jing-v6 refresh-mid is public,
// not read-only) and simulation arguments are fixed at build time:
//
//   pass 1 - call refresh-mid on a fork, read the mid the market itself derives
//   pass 2 - build the amount ladder from THAT mid, with limit = floor-of(mid),
//            exactly as the vault does (mid * (10000 - leeway-bps) / 10000)
//
// An earlier attempt supplied a mid taken from rfq get-native-price and every
// size returned out u0 - including 10,000 sats, which plainly does sell. That
// was wrong arguments, not a router refusing dust, so it is redone here.
//
// Run: PYTH_API_KEY=... node simulations/dust-router-stxer.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let require = createRequire(resolve(workspace, 'fastpool-pox-5/package.json'));
try { require.resolve('stxer'); }
catch { require = createRequire(resolve(workspace, 'stacking-juice/stx-juice/package.json')); }
const { SimulationBuilder, getSimulationResult } = require('stxer');
const { Cl, deserializeCV, cvToString } = require('@stacks/transactions');

const DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const MARKET = `${DEP}.markets-sbtc-stx-jing-v6`;
const ROUTER = `${DEP}.swap-router-sbtc-stx-jing-v5`;
const NODE = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
const API = process.env.STXER_API_URL || 'https://api.stxer.xyz';
const LEEWAY_BPS = 1000n; // the vaults' default

const { fetchLazerUpdateAny } = await import(resolve(workspace, 'jing-contracts-v3/simulations/_lazer.js'));
const proof = await fetchLazerUpdateAny();
const update = Cl.buffer(Buffer.from(proof.hex.replace(/^0x/, ''), 'hex'));

const tip = (await (await fetch(`${NODE}/extended/v1/block?limit=1`, { signal: AbortSignal.timeout(20000) })).json()).results[0];
const decode = (step) => {
  const hex = step?.Eval?.Ok ?? step?.Transaction?.Ok?.result ?? null;
  if (!hex) return JSON.stringify(step ?? null);
  try { return cvToString(deserializeCV(Buffer.from(hex, 'hex'))); } catch { return hex; }
};

// ---- pass 1: what mid does the market itself produce right now? -------------
const p1 = SimulationBuilder.new({ stacksNodeAPI: NODE, apiEndpoint: API }).useBlockHeight(tip.height).withSender(DEP);
p1.addContractCall({ contract_id: MARKET, function_name: 'refresh-mid', function_args: [update], sender: DEP });
const id1 = await p1.run();
console.log(`pass 1: https://stxer.xyz/simulations/mainnet/${id1}`);
const r1 = await getSimulationResult(id1, { stxerApi: API });
const midStr = decode(r1.steps[0]?.Result);
console.log(`refresh-mid -> ${midStr}`);
const m = /u(\d+)/.exec(midStr);
if (!m) throw new Error(`could not read a mid from: ${midStr}`);
const mid = BigInt(m[1]);
const limit = (mid * (10000n - LEEWAY_BPS)) / 10000n;
console.log(`mid ${mid}, limit (floor-of, ${LEEWAY_BPS} bps leeway) ${limit}`);

// ---- pass 2: the ladder, on the market's own mid ----------------------------
const p2 = SimulationBuilder.new({ stacksNodeAPI: NODE, apiEndpoint: API }).useBlockHeight(tip.height).withSender(DEP);
const plan = [];
// refresh-mid first, so the router sees the same fresh oracle state the vault
// would have written a moment earlier.
p2.addContractCall({ contract_id: MARKET, function_name: 'refresh-mid', function_args: [update], sender: DEP });
plan.push({ label: 'refresh-mid (prime the oracle, as the vault does)' });
const LADDER = [1, 2, 3, 1000, 2000, 3000, 5000, 8000, 9000, 9500, 10000];
for (const sats of LADDER) {
  p2.addContractCall({
    contract_id: ROUTER, function_name: 'smart-swap-sbtc-for-stx',
    function_args: [Cl.uint(sats), Cl.uint(limit), Cl.some(update), Cl.uint(mid), Cl.uint(0)], sender: DEP,
  });
  plan.push({ label: `${sats} sat(s)`, sats });
}
console.log(`pass 2: submitting ${plan.length} steps at block ${tip.height}`);
const id2 = await p2.run();
console.log(`pass 2: https://stxer.xyz/simulations/mainnet/${id2}`);
const r2 = await getSimulationResult(id2, { stxerApi: API });

const rows = plan.map((p, i) => {
  const s = decode(r2.steps[i]?.Result);
  const out = /\(out (u\d+)\)/.exec(s)?.[1] ?? '-';
  const unsold = /\(unsold (u\d+)\)/.exec(s)?.[1] ?? '-';
  return { ...p, out, unsold, raw: s };
});
console.log('\n amount |        out |     unsold | sells?');
for (const r of rows.filter((r) => r.sats !== undefined)) {
  const sells = r.out !== 'u0' && r.out !== '-';
  console.log(` ${String(r.sats).padStart(6)} | ${r.out.padStart(10)} | ${r.unsold.padStart(10)} | ${sells ? 'YES' : 'no'}`);
}
const smallest = rows.filter((r) => r.sats !== undefined && r.out !== 'u0' && r.out !== '-')[0];
console.log(smallest
  ? `\nSmallest amount the router will sell: ${smallest.sats} sat(s) -> ${smallest.out}`
  : '\nNothing on the ladder sold - the arguments are still wrong, do not draw a dust conclusion.');

const dir = resolve(dirname(fileURLToPath(import.meta.url)), 'results/dust-router');
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'result.txt'),
  `pass1 ${id1}\npass2 ${id2}\nmid ${mid}\nlimit ${limit}\n\n` +
  rows.map((r) => `${String(r.sats ?? '-').padStart(6)}  out=${r.out}  unsold=${r.unsold}\n        ${r.raw}`).join('\n') + '\n');
