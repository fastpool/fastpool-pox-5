// Can each VAULT sweep a small balance through its own router-swap?
//
// The earlier run called swap-router-sbtc-stx-jing-v5 directly and small
// amounts reverted (err none). That was misleading: the vaults call it inside
// `as-contract?` with an allowance of `amount + (get min-token-x mins)`, the
// extra headroom the book's minimum deposit needs. So the question has to be
// asked through the vault, not around it.
//
// Each vault is deployed as a test copy with POOL repointed at a standard
// principal, so this driver can call the POOL-gated entry points; everything
// else - window logic, price derivation, allowances, close-if-empty - is the
// production source, unchanged.
//
// Per vault: fund N sats, open the window, drop it to zero so the routed path
// is live, router-swap, then read is-empty.
//
// CityCoins uses a direct token donation and an aged batch clock fixture.
// Run: node simulations/dust-vaults-stxer.mjs [sats...]
import {appendJingStack,freshProofAfter,SBTC,FORK_BLOCK} from './_jing-v6-3.mjs';
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

const DEP = 'SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const NODE = process.env.STACKS_API_URL || 'http://77.42.3.101/stacks-api';
const API = process.env.STXER_API_URL || 'https://api.stxer.xyz';

const AMOUNTS = (process.argv.slice(2).map(Number).filter(Number.isInteger));
const LADDER = AMOUNTS.length ? AMOUNTS : [1, 500, 1000, 2000];

const VAULTS = [
  { key: 'fast', name: 'fastpool-swap-vault',
    src: resolve(workspace, 'fastpool-pox-5/contracts/fastpool-swap-vault.clar'),
    pool: '(define-constant POOL .signer-manager-vault-stx-rewards)' },
  { key: 'juice', name: 'juice-sbtc-autoswap',
    src: resolve(workspace, 'juicestx/contracts/pox-5/juice-sbtc-autoswap.clar'),
    pool: '(define-constant POOL .juice-pool-sbtc-signer)' },
  { key: 'ccd016', name: 'ccd016-swap-vault-mia-v2',
    src: resolve(workspace, 'citycoins-protocol/contracts/extensions/ccd016-swap-vault-mia-v2.clar'),
    pool: null },
];

const { fetchLazerUpdateAny } = await import(resolve(workspace, 'jing-contracts-v3/simulations/_lazer.js'));
const tip = (await (await fetch(`${NODE}/extended/v1/block?limit=1`, { signal: AbortSignal.timeout(20000) })).json()).results[0];

const proof=await freshProofAfter(tip.block_time);
const update=Cl.buffer(Buffer.from(proof.hex.replace(/^0x/, ''), 'hex'));
const decode = (step) => {
  const hex = step?.Eval?.Ok ?? step?.Transaction?.Ok?.result ?? null;
  if (!hex) return JSON.stringify(step ?? null);
  try { return cvToString(deserializeCV(Buffer.from(hex, 'hex'))); } catch { return hex; }
};

// Production source with only the authority gate repointed at this driver.
function testSource(v) {
  let s = readFileSync(v.src, 'utf8');
  if (v.pool) {
    if (!s.includes(v.pool)) throw new Error(`${v.key}: POOL constant not found`);
    s = s.replace(v.pool, `(define-constant POOL '${DEP})`);
  } else {
    // ccd016 gates on the DAO; open it for the driver only.
    const start=s.indexOf('(define-public (is-dao-or-extension)'),end=s.indexOf('(define-public (callback',start);
    if(start<0||end<0)throw Error('DAO gate not found');
    s=s.slice(0,start)+`(define-public (is-dao-or-extension) (ok (asserts! (is-eq tx-sender '${DEP}) (err u16000))))\n\n`+s.slice(end);
  }
  return s;
}

const builder = SimulationBuilder.new({ stacksNodeAPI: NODE, apiEndpoint: API })
  .useBlockHeight(tip.height).withSender(DEP);
const plan = [];
appendJingStack(builder,plan);
builder.addContractDeploy({contract_name:'ccd015-redemption-book-mia-stx',source_code:readFileSync(resolve(workspace,'citycoins-protocol/contracts/extensions/ccd015-redemption-book-mia-stx.clar'),'utf8'),clarity_version:ClarityVersion.Clarity6});
plan.push({label:'deploy CityCoins book',kind:'deploy'});
const push = (label, meta = {}) => plan.push({ label, ...meta });

for (const v of VAULTS) {
  for (const sats of LADDER) {
    const cname = `t-${v.key}-${sats}`;
    const cid = `${DEP}.${cname}`;
    builder.addContractDeploy({ contract_name: cname, source_code: testSource(v), clarity_version: ClarityVersion.Clarity6 });
    push(`${v.key}/${sats}: deploy test copy`, { vault: v.key, sats, kind: 'deploy' });

    // window-blocks u0 -> the routed path is live immediately (a supported mode)
    builder.addContractCall({ contract_id: cid, function_name: 'set-window-blocks', function_args: [Cl.uint(0)], sender: DEP });
    push(`${v.key}/${sats}: set-window-blocks u0`, { vault: v.key, sats });

    const whale='SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2';
    builder.addContractCall({contract_id:SBTC,function_name:'transfer',function_args:[Cl.uint(sats),Cl.principal(whale),Cl.principal(v.pool?DEP:cid),Cl.none()],sender:whale});
    push(`${v.key}/${sats}: real token funding`,{vault:v.key,sats});
    if(v.pool)builder.addContractCall({ contract_id: cid, function_name: 'fund', function_args: [Cl.uint(sats)], sender: DEP });
    else builder.addEvalCode(cid,'(begin (var-set batch-start (some (- burn-block-height u1))) (ok true))');
    push(`${v.key}/${sats}: fund ${sats} sats`, { vault: v.key, sats });

    builder.addContractCall({ contract_id: cid, function_name: 'router-swap', function_args: [update], sender: DEP });
    push(`${v.key}/${sats}: router-swap ${sats}`, { vault: v.key, sats, measure: 'swap' });

    builder.addEvalCode(cid, '(is-empty)');
    push(`${v.key}/${sats}: is-empty after`, { vault: v.key, sats, measure: 'empty' });
    builder.addEvalCode(cid,`(unwrap-panic (contract-call? '${SBTC} get-balance current-contract))`);
    push(`${v.key}/${sats}: sBTC balance after`,{vault:v.key,sats,measure:'balance'});
  }
}

console.log(`submitting ${plan.length} steps at block ${FORK_BLOCK??tip.height} (amounts: ${LADDER.join(', ')})`);
const id = await builder.run();
console.log(`View: https://stxer.xyz/simulations/mainnet/${id}`);
const result = await getSimulationResult(id, { stxerApi: API });

const rows = plan.map((p, i) => ({ ...p, actual: decode(result.steps[i]?.Result) }));
console.log('\n vault   | sats  | router-swap                       | is-empty');
for (const v of VAULTS) {
  for (const sats of LADDER) {
    const swap = rows.find((r) => r.vault === v.key && r.sats === sats && r.measure === 'swap');
    const empty = rows.find((r) => r.vault === v.key && r.sats === sats && r.measure === 'empty');
    const s = (swap?.actual ?? '').startsWith('(ok') ? 'ok' : (swap?.actual ?? '?');
    console.log(` ${v.key.padEnd(7)} | ${String(sats).padStart(5)} | ${s.slice(0, 33).padEnd(33)} | ${empty?.actual ?? '?'}`);
  }
}

const dir = resolve(dirname(fileURLToPath(import.meta.url)), 'results/dust-vaults');
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'result.txt'),
  `simulation ${id}\namounts ${LADDER.join(', ')}\n\n` +
  rows.map((r) => `${r.label}\n        ${r.actual}`).join('\n') + '\n');

// Tiny AMM trades may refuse on rounding/min-output; rejection must retain all sBTC.
// All three vaults intentionally treat balances <= DUST_SATS (2) as empty.
const checks=rows.filter(r=>!r.measure).map(r=>({...r,passed:r.actual.startsWith('(ok')}));
for(const v of VAULTS)for(const sats of LADDER){
 const row=m=>rows.find(r=>r.vault===v.key&&r.sats===sats&&r.measure===m);
 const swap=row('swap'),empty=row('empty'),balance=row('balance');
 const filled=swap.actual.startsWith('(ok');
 checks.push({label:`${v.key}/${sats}: accepted trade drains vault or refusal preserves funds`,actual:swap.actual+'; '+empty.actual+'; '+balance.actual,passed:(filled||swap.actual.startsWith('(err'))&&empty.actual===(filled||sats<=2?'true':'false')&&balance.actual===`u${filled?0:sats}`});
}
writeFileSync(resolve(dir,'v6-3.json'),JSON.stringify({id,url:`https://stxer.xyz/simulations/mainnet/${id}`,forkBlock:FORK_BLOCK??tip.height,checks,fixtures:['Pool authority rebound in test copies; CityCoins DAO gate restricted to test sender','CityCoins receives a real token donation and an aged batch clock; treasury funding covered in main recovery matrix'],rows},null,2)+'\n');
console.log(`${checks.filter(c=>c.passed).length}/${checks.length} checks green`);
if(checks.some(c=>!c.passed))throw Error('Dust diagnostic failure: '+JSON.stringify(checks.filter(c=>!c.passed)));
