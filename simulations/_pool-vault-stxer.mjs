import {appendJingStack,FORK_BLOCK} from './_jing-v6-3.mjs';
// Shared fork runner; exact production pool/vault sources are deployed unchanged.
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
let require=createRequire(resolve(workspace,'fastpool-pox-5/package.json'));
try { require.resolve('stxer'); }
catch { require=createRequire(resolve(workspace,'stacking-juice/stx-juice/package.json')); }
const {SimulationBuilder,getSimulationResult}=require('stxer');
const {Cl,ClarityVersion,deserializeCV,cvToString}=require('@stacks/transactions');
const DEP='SPV9K21TBFAK4KNRJXF5DFP8N7W46G4V9RCJDC22';
const STRANGER='SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM';
const NODE=process.env.STACKS_API_URL||'http://77.42.3.101/stacks-api';
const API=process.env.STXER_API_URL||'https://api.stxer.xyz';
const POX='SP000000000000000000002Q6VF78.pox-5';
export async function runPoolVaultFork({kind,poolSource,vaultSource,resultDirectory}) {
 const pool=kind==='juice'?'juice-pool-stx-signer-stx-rewards':'signer-manager-vault-stx-rewards';
 const vault=kind==='juice'?'juice-pool-swap-vault':'fastpool-swap-vault';
 const pid=`${DEP}.${pool}`,vid=`${DEP}.${vault}`;
 const {fetchLazerUpdateAny}=await import(resolve(workspace,'jing-contracts-v3/simulations/_lazer.js'));
 const proof=await fetchLazerUpdateAny();
 const update=Cl.buffer(Buffer.from(proof.hex.replace(/^0x/,''),'hex'));
 const tipResponse=await fetch(`${NODE}/extended/v1/block?limit=1`,{signal:AbortSignal.timeout(20000)});
 if(!tipResponse.ok)throw new Error(`tip HTTP ${tipResponse.status}`);
 const tip=(await tipResponse.json()).results[0];
 const builder=SimulationBuilder.new({stacksNodeAPI:NODE,apiEndpoint:API}).useBlockHeight(tip.height).withSender(DEP);
 const plan=[],sourceHashes={};
 appendJingStack(builder,plan,sourceHashes);
 const deploy=(name,path)=>{const source=readFileSync(path,'utf8');sourceHashes[name]=createHash('sha256').update(source).digest('hex');builder.addContractDeploy({contract_name:name,source_code:source,clarity_version:ClarityVersion.Clarity6});plan.push({label:`deploy unchanged ${name}`,kind:'deploy'});};
 const call=(label,id,fn,args,want,sender=STRANGER)=>{if (/^deposit-token-[xy]$/.test(fn)&&args.length===6)args=args.filter((_,i)=>i!==3);builder.addContractCall({contract_id:id,function_name:fn,function_args:args,sender});plan.push({label,kind:'tx',want});};
 const ev=(label,id,code,want)=>{builder.addEvalCode(id,code);plan.push({label,kind:'eval',want});};
 deploy(vault,vaultSource);deploy(pool,poolSource);
 ev('real PoX-5 cycle',POX,'(current-pox-reward-cycle)',v=>/^u\d+$/.test(v));
 ev('vault clock initially clear',vid,'(get-clock)',v=>v.includes('(batch-start none)')&&v.includes('(window-open false)'));
 call('outsider cannot fund',vid,'fund',[Cl.uint(1)],'(err u16000)');
 call('outsider cannot finish or redirect STX',vid,'finish',[],'(err u16000)');
 call('reclaim blocked before a batch exists',vid,'jing-reclaim',[],'(err u16031)');
 call('maker placement requires active patience window (real signed update)',vid,'jing-place',[update],'(err u16030)');
 call('router blocked before liquidation (real signed update)',vid,'router-swap',[update],'(err u16031)');
 call('outsider cannot refloor',vid,'jing-refloor',[update],'(err u16000)');
 if(kind==='juice') {
  ev('no pending tranche',pid,'(get-pending-swap)','none');
  call('cannot finalize nonexistent tranche',pid,'finalize-swap',[],'(err u115)');
  call('cannot mark unpaid zero-pot tranche paid',pid,'pay-stx-stakers',[Cl.list([Cl.principal(STRANGER)]),Cl.uint(144),Cl.uint(0)],'(err u115)');
 } else {
  ev('no active vault cycle',pid,'(get-vault-cycle)','none');
  call('cannot finalize nonexistent batch',pid,'finalize-swap-vault',[Cl.contractPrincipal(DEP,vault)],'(err u1053)');
  call('cannot fund unclaimed cycle',pid,'fund-swap-vault',[Cl.uint(144),Cl.contractPrincipal(DEP,vault)],'(err u1020)');
  ev('no timed sBTC fallback',pid,'(get-unswapped-for-cycle u144)','u0');
  // Pyth Lazer fee budget: the vault setter is pool-gated and bounded at 10 STX.
  const fv=Cl.contractPrincipal(DEP,vault);
  ev('pyth fee budget starts at 0',vid,'(get-config)',v=>v.includes('(pyth-fee-budget u0)'));
  call('outsider cannot set vault pyth fee budget directly',vid,'set-pyth-fee-budget',[Cl.uint(10)],'(err u16000)');
  call('outsider cannot use pool pyth fee budget wrapper',pid,'set-vault-pyth-fee-budget',[Cl.uint(10),fv],'(err u1001)');
  builder.addContractDeploy({contract_name:'fastpool-swap-vault-alt',source_code:readFileSync(vaultSource,'utf8'),clarity_version:ClarityVersion.Clarity6});
  plan.push({label:'deploy second copy of the vault (conforms to trait v2, not active)',kind:'deploy'});
  call('wrapper refuses a vault that is not the active one',pid,'set-vault-pyth-fee-budget',[Cl.uint(10),Cl.contractPrincipal(DEP,'fastpool-swap-vault-alt')],'(err u1055)',DEP);
  call('wrapper refuses budget above 10 STX',pid,'set-vault-pyth-fee-budget',[Cl.uint(10000001),fv],'(err u16033)',DEP);
  ev('budget unchanged after refusals',vid,'(get-config)',v=>v.includes('(pyth-fee-budget u0)'));
  call('admin sets budget at the 10 STX bound',pid,'set-vault-pyth-fee-budget',[Cl.uint(10000000),fv],'(ok true)',DEP);
  ev('get-config reports 10 STX budget',vid,'(get-config)',v=>v.includes('(pyth-fee-budget u10000000)'));
  call('admin resets budget to 0',pid,'set-vault-pyth-fee-budget',[Cl.uint(0),fv],'(ok true)',DEP);
  ev('get-config reports 0 budget',vid,'(get-config)',v=>v.includes('(pyth-fee-budget u0)'));
 }
 call('outsider cannot use pool admin refloor',pid,'refloor-vault',kind==='juice'?[update]:[update,Cl.contractPrincipal(DEP,vault)],kind==='juice'?'(err u100)':'(err u1001)');
 console.log(`${kind}: submitting ${plan.length} deployment/integration/guard checks at mainnet block ${tip.height}`);
 const id=await builder.run();
 console.log(`View: https://stxer.xyz/simulations/mainnet/${id}`);
 const result=await getSimulationResult(id,{stxerApi:API});
 const checks=plan.map((p,i)=>{
  const step=result.steps[i]?.Result;
  let actual;
  if(p.kind==='eval'){
   const r=step?.Eval;actual=r?.Ok!==undefined?cvToString(deserializeCV(r.Ok)):`ENGINE ${JSON.stringify(r)}`;
  }else{
   const r=step?.Transaction;
   actual=r?.Ok&&!r.Ok.vm_error?cvToString(deserializeCV(r.Ok.result)):`ENGINE ${JSON.stringify(r)}`;
  }
  const passed=p.kind==='deploy'?actual.startsWith('(ok'):typeof p.want==='function'?p.want(actual):actual===p.want;
  console.log(`${passed?'PASS':'FAIL'} ${p.label}: ${actual.slice(0,240)}`);
  return {label:p.label,passed,actual};
 });
 mkdirSync(resultDirectory,{recursive:true});
 const report={id,url:`https://stxer.xyz/simulations/mainnet/${id}`,kind,mode:'deployment-and-guards',block:FORK_BLOCK??tip.height,burn:tip.burn_block_height,proofTimestamp:proof.ts,productionSourcesUnmodified:true,sourceHashes,checks,result};
 writeFileSync(resolve(resultDirectory,`${kind}-deployment-guards.json`),JSON.stringify(report,null,2));
 if(checks.some(c=>!c.passed))throw new Error(`${kind}: ${checks.filter(c=>!c.passed).length} fork checks failed`);
 console.log(`${kind}: ${checks.length}/${checks.length} fork checks passed`);
 return report;
}

// Reward/share fixtures are explicit fork storage seeds. PoX, market, router,
// pool and vault source stay unchanged; this does not test STX lock admission.
export async function runPoolVaultLifecycle({kind,poolSource,vaultSource,resultDirectory,profile="liquidation"}) {
 const {getAddressFromPrivateKey,serializeCV}=require('@stacks/transactions');
 const pool=kind==='juice'?'juice-pool-stx-signer-stx-rewards':'signer-manager-vault-stx-rewards';
 const vault=kind==='juice'?'juice-pool-swap-vault':'fastpool-swap-vault';
 const pid=`${DEP}.${pool}`,vid=`${DEP}.${vault}`;
 const SBTC='SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token';
 const MKT=`${DEP}.markets-sbtc-stx-jing-v6-3`;
 const WHALE='SM2RRFN4HXTS7EYP8MHHYKSTG118S3HKGDV8AB8M1';
 const ALICE=getAddressFromPrivateKey('7'.repeat(64)+'01','mainnet');
 const BOB=getAddressFromPrivateKey('8'.repeat(64)+'01','mainnet');
 const {fetchLazerUpdateAny}=await import(resolve(workspace,'jing-contracts-v3/simulations/_lazer.js'));
 const proof=await fetchLazerUpdateAny();
 const update=Cl.buffer(Buffer.from(proof.hex.replace(/^0x/,''),'hex'));
 const tip=(await (await fetch(`${NODE}/extended/v1/block?limit=1`)).json()).results[0];
 const read=async(id,fn,args=[])=>{
  const [address,name]=id.split('.');
  const r=await fetch(`${NODE}/v2/contracts/call-read/${address}/${name}/${fn}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sender:DEP,arguments:args.map(cv=>'0x'+serializeCV(cv).replace(/^0x/,''))})});
  const body=await r.json();if(!body.okay)throw new Error(`${fn}: ${JSON.stringify(body).slice(0,200)}`);
  return deserializeCV(body.result);
 };
 const cycle=Number((await read(POX,'current-pox-reward-cycle')).value)-1;
 const sellers={value:[]},buyers={value:[]}; // Fresh v6-3 books are empty.
 const builder=SimulationBuilder.new({stacksNodeAPI:NODE,apiEndpoint:API,skipTracing:true}).useBlockHeight(tip.height).withSender(DEP);
 const plan=[],sourceHashes={};
 appendJingStack(builder,plan,sourceHashes);
 const deploy=(name,path)=>{const source=readFileSync(path,'utf8');sourceHashes[name]=createHash('sha256').update(source).digest('hex');builder.addContractDeploy({contract_name:name,source_code:source,clarity_version:ClarityVersion.Clarity6});plan.push({label:`deploy unchanged ${name}`,kind:'deploy'});};
 const call=(label,id,fn,args,want,sender=DEP)=>{if (/^deposit-token-[xy]$/.test(fn)&&args.length===6)args=args.filter((_,i)=>i!==3);builder.addContractCall({contract_id:id,function_name:fn,function_args:args,sender});plan.push({label,kind:'tx',want});};
 const ev=(label,id,code,want)=>{builder.addEvalCode(id,code);plan.push({label,kind:'eval',want});};
 const advance=(n)=>{builder.addAdvanceBlocks({bitcoin_blocks:n,stacks_blocks_per_bitcoin:1,bitcoin_interval_secs:1});plan.push({label:`advance ${n} burn blocks, compressed timestamps`,kind:'advance'});};
 const ok=v=>v.startsWith('(ok');
 deploy(vault,vaultSource);deploy(pool,poolSource);
 const FUND=100000;
 call('fund real PoX sBTC balance (fork only)',SBTC,'transfer',[Cl.uint(FUND),Cl.principal(WHALE),Cl.principal(POX),Cl.none()],'(ok true)',WHALE);
 const key=`{ reward-cycle: u${cycle}, bond-index: none, signer: '${pid} }`;
 ev('fixture: crystallized PoX rewards and 1:3 shares',POX,`(begin
  (map-set signer-shares-staked-for-cycle ${key} u4)
  (map-set signer-pending-staked-ustx-per-cycle { signer: '${pid}, cycle: u${cycle} } u4)
  (map-set signer-rewards-per-token-settled-for-cycle ${key} (get-rewards-per-token-for-cycle u${cycle} none))
  (map-set signer-unclaimed-rewards-for-cycle ${key} u${FUND})
  (map-set staker-shares-staked-for-cycle { reward-cycle: u${cycle}, bond-index: none, signer: '${pid}, staker: '${ALICE} } u1)
  (map-set staker-shares-staked-for-cycle { reward-cycle: u${cycle}, bond-index: none, signer: '${pid}, staker: '${BOB} } u3)
  (var-set last-accounted-rewards-only (+ (var-get last-accounted-rewards-only) u${FUND}))
  (try! (contract-call? '${pid} validate-stake! '${ALICE} u${cycle} u1 u1 u0 false none))
  (try! (contract-call? '${pid} validate-stake! '${BOB} u${cycle} u1 u3 u0 false none))
  (ok true))`,'(ok true)');
 ev('fixture persisted in unchanged PoX',POX,`(get-signer-unclaimed-rewards-for-cycle '${pid} u${cycle} none)`,`u${FUND}`);
 if(kind==='juice')call('real PoX claim flows to vault',pid,'pox-claim-rewards',[Cl.list([]),Cl.uint(cycle)],v=>ok(v)&&v.includes(`(total-rewards u${FUND})`));
 else {
  call('real PoX claim stages reward pot',pid,'claim-rewards',[Cl.uint(cycle)],`(ok u${FUND})`);
  call('send cycle pot into vault',pid,'fund-swap-vault',[Cl.uint(cycle),Cl.contractPrincipal(DEP,vault)],`(ok u${FUND})`);
 }
 ev('vault received all real sBTC',vid,`(contract-call? '${SBTC} get-balance current-contract)`,`(ok u${FUND})`);
 // Clear preexisting live orders in this fork so a midpoint ask can rest.
 for(const [side,orders] of [['x',sellers],['y',buyers]])for(const order of orders.value){
  const who=order.value;
  if(who.includes('.'))throw new Error('book contains a contract maker; use a separate isolated market fixture');
  call(`fork cleanup existing ${side} maker ${who.slice(0,8)}`,MKT,`cancel-token-${side}-deposit`,[Cl.contractPrincipal(...(side==='x'?SBTC:'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2').split('.')),Cl.stringAscii(side==='x'?'sbtc-token':'wstx')],ok,who);
 }
 call('real Jing maker placement',vid,'jing-place',[update],v=>ok(v)&&v.includes(`(amount u${FUND})`),STRANGER);
 call('router forbidden during patience',vid,'router-swap',[update],'(err u16031)',STRANGER);
 call('cannot finalize while reward is resting',pid,kind==='juice'?'finalize-swap':'finalize-swap-vault',kind==='juice'?[]:[Cl.contractPrincipal(DEP,vault)],kind==='juice'?'(err u16032)':'(err u16032)');
 if(profile==='maker') {
  const mid=proof.px*100000000n/proof.py;
  const [sbtcAddress,sbtcName]=SBTC.split('.');
  const wstx=Cl.contractPrincipal('SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR','token-stx-v-1-2');
  call('additional real maker depth behind vault',MKT,'deposit-token-x',[Cl.uint(FUND),Cl.uint(mid*101n/100n),Cl.none(),update,Cl.contractPrincipal(sbtcAddress,sbtcName),Cl.stringAscii('sbtc-token')],`(ok u${FUND})`,WHALE);
  const take=BigInt(FUND)*mid/10000000000n*150n/100n;
  call('real STX taker fills vault at verified oracle mid',MKT,'swap',[Cl.uint(take),Cl.uint(mid*105n/100n),update,Cl.contractPrincipal(sbtcAddress,sbtcName),Cl.stringAscii('sbtc-token'),wstx,Cl.stringAscii('wstx'),Cl.bool(false)],ok,'SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51');
  ev('vault completely sold in patience phase',vid,'(is-empty)','true');
  call('close externally filled batch',vid,'close-batch',[],ok,STRANGER);
  ev('maker-filled batch ready to finish',vid,'(get-clock)',v=>v.includes('(batch-start none)')&&v.includes('(ready-to-finish true)'));
 } else {
 call('set chunk cap to preserve the two-chunk scenario',pid,'set-vault-max-chunk-sats',[Cl.uint(50000),Cl.contractPrincipal(DEP,vault)],'(ok true)');
 ev('fixture: patience clock elapsed without altering signed-feed freshness',vid,'(begin (var-set batch-start (some (- burn-block-height u288))) true)','true');
 ev('patience window elapsed',vid,'(get-clock)',v=>v.includes('(window-elapsed true)'));
 call('reclaim from real Jing market',vid,'jing-reclaim',[],v=>ok(v)&&v.includes(`(amount u${FUND})`),STRANGER);
 // router-swap takes no size: with 100k held and a 50k cap a stranger sells exactly one full chunk, never a sliver
 call('real router: stranger sells exactly one full 50k chunk',vid,'router-swap',[update],v=>ok(v)&&v.includes('(amount u50000)')&&v.includes('(unsold u0)'),STRANGER);
 ev('one full chunk left the vault, 50k remain',vid,`(contract-call? '${SBTC} get-balance current-contract)`,'(ok u50000)');
 call('same-burn-block second sale rejected (u16044 cooldown)',vid,'router-swap',[update],'(err u16044)',STRANGER);
 call('cannot finalize a half-sold batch',pid,kind==='juice'?'finalize-swap':'finalize-swap-vault',kind==='juice'?[]:[Cl.contractPrincipal(DEP,vault)],kind==='juice'?'(err u16032)':'(err u16032)');
 advance(1);
 call('real router: second reward chunk sells the remaining 50k',vid,'router-swap',[update],v=>ok(v)&&v.includes('(amount u50000)')&&v.includes('(unsold u0)'),STRANGER);
 ev('vault drained after two chunks',vid,'(is-empty)','true');
 }
 const finalSlot=plan.length;
 call('attribute real native STX back to pool',pid,kind==='juice'?'finalize-swap':'finalize-swap-vault',kind==='juice'?[]:[Cl.contractPrincipal(DEP,vault)],v=>/^\(ok u[1-9]\d*\)$/.test(v));
 const aliceBefore=plan.length;ev('Alice STX before payout',pid,`(stx-get-balance '${ALICE})`,v=>/^u\d+$/.test(v));
 const bobBefore=plan.length;ev('Bob STX before payout',pid,`(stx-get-balance '${BOB})`,v=>/^u\d+$/.test(v));
 call('pay 1:3 shares in real native STX',pid,kind==='juice'?'pay-stx-stakers':'distribute-rewards-many',kind==='juice'?[Cl.list([Cl.principal(ALICE),Cl.principal(BOB)]),Cl.uint(cycle),Cl.uint(0)]:[Cl.list([Cl.principal(ALICE),Cl.principal(BOB)]),Cl.uint(cycle)],ok);
 const aliceAfter=plan.length;ev('Alice STX after payout',pid,`(stx-get-balance '${ALICE})`,v=>/^u\d+$/.test(v));
 const bobAfter=plan.length;ev('Bob STX after payout',pid,`(stx-get-balance '${BOB})`,v=>/^u\d+$/.test(v));
 call('repeating batch payout is safe',pid,kind==='juice'?'pay-stx-stakers':'distribute-rewards-many',kind==='juice'?[Cl.list([Cl.principal(ALICE),Cl.principal(BOB)]),Cl.uint(cycle),Cl.uint(0)]:[Cl.list([Cl.principal(ALICE),Cl.principal(BOB)]),Cl.uint(cycle)],ok);
 ev('Alice unchanged on replay',pid,`(stx-get-balance '${ALICE})`,v=>/^u\d+$/.test(v));
 ev('vault clears clock after attribution',vid,'(get-clock)',v=>v.includes('(batch-start none)'));
 console.log(`${kind}: ${plan.length} ${profile} lifecycle checks with real tokens and venues; explicit earned-reward fixtures`);
 const id=await builder.run();console.log(`View: https://stxer.xyz/simulations/mainnet/${id}`);
 const result=await getSimulationResult(id,{stxerApi:API});
 const checks=plan.map((p,i)=>{
  const step=result.steps[i]?.Result;let actual;
  if(p.kind==='advance')actual=step?.AdvanceBlocks?.Ok?'ok':`ENGINE ${JSON.stringify(step)}`;
  else if(p.kind==='eval')actual=step?.Eval?.Ok!==undefined?cvToString(deserializeCV(step.Eval.Ok)):`ENGINE ${JSON.stringify(step)}`;
  else actual=step?.Transaction?.Ok&&!step.Transaction.Ok.vm_error?cvToString(deserializeCV(step.Transaction.Ok.result)):`ENGINE ${JSON.stringify(step)}`;
  const passed=p.kind==='advance'?actual==='ok':p.kind==='deploy'?actual.startsWith('(ok'):typeof p.want==='function'?p.want(actual):actual===p.want;
  console.log(`${passed?'PASS':'FAIL'} ${p.label}: ${actual.slice(0,240)}`);return {label:p.label,passed,actual};
 });
 const uint=s=>BigInt(s.match(/u(\d+)/)?.[1]??'-1');
 if(checks.every(c=>c.passed)){
  const out=uint(checks[finalSlot].actual);
  for(const [name,before,after,shares] of [['Alice',aliceBefore,aliceAfter,1n],['Bob',bobBefore,bobAfter,3n]]){
   const delta=uint(checks[after].actual)-uint(checks[before].actual);const expected=out*shares/4n;
   checks.push({label:`${name} native STX matches pro-rata entitlement`,passed:delta===expected,actual:`${delta}, expected ${expected}`});
  }
  checks.push({label:'payout replay does not transfer more STX',passed:checks[aliceAfter+3].actual===checks[aliceAfter].actual,actual:'compared Alice balance before/after replay'});
 }
 mkdirSync(resultDirectory,{recursive:true});
 const report={id,url:`https://stxer.xyz/simulations/mainnet/${id}`,kind,mode:`real-token-venue-${profile}`,block:FORK_BLOCK??tip.height,burn:tip.burn_block_height,proofTimestamp:proof.ts,productionSourcesUnmodified:true,sourceHashes,fixtures:['PoX earned rewards and 1:3 shares seeded with Eval; no STX lock admission tested',profile==='maker'?'maker fill completes without advancing burn blocks':'Vault funding clock aged by 288 blocks; one burn block advances for router cooldown; production freshness unchanged','Fresh exact v6-3 stack deployed; no old market state inherited'],checks,result};
 writeFileSync(resolve(resultDirectory,`${kind}-${profile}.json`),JSON.stringify(report,null,2));
 if(checks.some(c=>!c.passed))throw new Error(`${kind} ${profile}: ${checks.filter(c=>!c.passed).length} lifecycle checks failed`);
 console.log(`${kind} ${profile}: ${checks.length}/${checks.length} lifecycle checks passed`);return report;
}
