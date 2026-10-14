// Focused fork scenarios for the swap-vault fixes that only passed `clarinet check`
// (jing-contracts-v3 README-audit-bounty-v6-3-submit-settle.md):
//   l1  Nested Quinn L-1: router-swap sells what fits inside the floor, keeps the rest;
//       a call that sells <= ROUTER_SLACK_SATS (8) reverts u16047
//   l2  Nested Quinn L-2: MAX_WINDOW_BLOCKS 288 (289 refused)
//   d6  Void Kael #6: a dust-only batch closes and finishes with 0 STX, next funding resumes
//   d7  Void Kael #7: a 1-sat jing-place after a sell-out; close-batch still closes at once
// Exact production vault + pool source, current Jing stack (JING_SRC). PoX earned-reward
// records and the elapsed patience clock are explicit Eval fixtures, as in the recovery matrix.
//   pf  Pyth Lazer fee budget: fee u10 on the live oracle; at budget 0 jing-take aborts and
//       router-swap drops the Jing book leg; both need a budget of 1 fee (abort at u9, pass at u10)
// Run: node simulations/vault-fixes-stxer.mjs [l1] [l2d6] [d7] [pf]   (no argument runs all)
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {stacks,stxer,appendJingStack,fetchLazerUpdateAny,lazerFeedTimes,DEP,MARKET,SBTC,WSTX,FORK_BLOCK} from './_jing-v6-3.mjs';
const {Cl,ClarityVersion,cvToString,deserializeCV,makeUnsignedContractDeploy,PostConditionMode,getAddressFromPrivateKey}=stacks;
const {SimulationBuilder,getSimulationResult,submitSimulationSteps,callContract,getNonce,setSender}=stxer;
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const NODE=process.env.STACKS_API_URL||'http://77.42.3.101/stacks-api';
const POX='SP000000000000000000002Q6VF78.pox-5',ROUTER=DEP+'.swap-router-sbtc-stx-jing-v5-3';
const WHALE='SP2C7BCAP2NH3EYWCCVHJ6K0DMZBXDFKQ56KR7QN2',STX_WHALE='SP9BP4PN74CNR5XT7CMAMBPA0GWC9HMB69HVVV51';
const VAULT=DEP+'.fastpool-swap-vault',POOL=DEP+'.signer-manager-vault-stx-rewards';
const stranger=getAddressFromPrivateKey('6'.repeat(64)+'01','mainnet'),cp=id=>Cl.principal(id),u=Cl.uint;
const ok=s=>s.startsWith('(ok'),uint=s=>BigInt(String(s).match(/u(\d+)/)?.[1]??'-1');
const decode=r=>r.Eval?.Ok?cvToString(deserializeCV(r.Eval.Ok)):r.Transaction?.Ok&&!r.Transaction.Ok.vm_error&&!r.Transaction.Ok.post_condition_aborted?cvToString(deserializeCV(r.Transaction.Ok.result)):`ENGINE ${JSON.stringify(r)}`;
const field=(s,name)=>uint(s.match(new RegExp(`\\(${name} u\\d+\\)`))?.[0]??'');
const resultDir=process.env.SIM_RESULTS_DIR||resolve(root,'simulations/results/vault-fixes');
const want=process.argv.slice(2),runs=[],checks=[],sourceHashes={};
let sid,caseName,step=0;
function save(){mkdirSync(resultDir,{recursive:true});writeFileSync(resolve(resultDir,'fastpool.json'),JSON.stringify({forkBlock:FORK_BLOCK??null,runs,checks,passed:checks.filter(c=>c.passed).length,total:checks.length,sourceHashes,fixtures:['PoX earned reward/share records seeded by Eval, backed by real fork sBTC transfers; lock admission not exercised','Patience clock aged by Eval (batch-start - 288) so the routed path is live on a fresh signed print','Opposite-side Jing makers are real public deposits; no market map writes']},null,2)+'\n');}
function check(label,actual,expect){const passed=typeof expect==='function'?expect(actual):actual===expect;checks.push({label:caseName+': '+label,actual:String(actual),expected:String(expect),passed,sid,step});console.log(`${passed?'ok':'FAIL'} ${checks.length}. ${caseName}: ${label}: ${String(actual).slice(0,420)}`);if(!passed){save();throw Error(`STOP ${caseName}: ${label}: ${actual}; expected ${expect}; step ${step}; https://stxer.xyz/simulations/mainnet/${sid}`);}}
async function ev(label,id,code,expect){const r=await submitSimulationSteps(sid,{steps:[{Eval:[DEP,'',id,code]}]});step++;const s=decode(r.steps[0]);if(expect!==undefined)check(label,s,expect);else if(s.startsWith('ENGINE'))check(label,s,()=>false);return s;}
async function tx(label,id,fn,args=[],expect=ok,sender=DEP){const r=await callContract(sid,{sender,contract:id,functionName:fn,functionArgs:args,fee:0});step++;check(label,r.vmError||r.result,expect);return r;}
async function advance(n){const r=await submitSimulationSteps(sid,{steps:[{AdvanceBlocks:{bitcoin_blocks:n,stacks_blocks_per_bitcoin:1,bitcoin_interval_secs:1}}]});step++;check(`advance ${n} burn block(s)`,r.steps[0]?.AdvanceBlocks?.Ok?'ok':JSON.stringify(r.steps[0]),'ok');}
async function deploy(n,path,code){const src=code??readFileSync(path,'utf8');sourceHashes[n]=createHash('sha256').update(src).digest('hex');const raw=await makeUnsignedContractDeploy({contractName:n,codeBody:src,clarityVersion:ClarityVersion.Clarity6,nonce:await getNonce(sid,DEP),network:'mainnet',publicKey:'',fee:0,postConditionMode:PostConditionMode.Allow});setSender(raw,DEP);const r=await submitSimulationSteps(sid,{steps:[{Transaction:raw.serialize()}]});step++;check('deploy '+n,decode(r.steps[0]),ok);}
const deployCode=(n,code)=>deploy(n,null,code);
// committed contract prints of one contract in a receipt, decoded
const prints=(r,id)=>(r.receipt?.events??[]).map(e=>typeof e==='string'?JSON.parse(e):e).filter(e=>e.committed!==false&&e.contract_event?.contract_identifier===id).map(e=>cvToString(deserializeCV(e.contract_event.raw_value)));
const bal=who=>`(unwrap-panic (contract-call? '${SBTC} get-balance '${who}))`;
const live=`(get-token-x-deposit (get-current-cycle) '${VAULT})`,parked=`(get-token-x-parked '${VAULT})`,pending=`(default-to u0 (get amount (get-token-x-pending-deposit '${VAULT})))`;
async function fresh(){const stamp=Number(uint(await ev('',MARKET,'stacks-block-time')));for(let i=0;i<40;i++){const p=await fetchLazerUpdateAny();if((await lazerFeedTimes(p.hex)).at>stamp)return {p,update:Cl.buffer(Buffer.from(p.hex.replace(/^0x/,''),'hex')),mid:p.px*100000000n/p.py};await new Promise(r=>setTimeout(r,2000));}throw Error('No fresh signed print');}
async function session(name){
 caseName=name;step=0;const b=SimulationBuilder.new({stacksNodeAPI:NODE}),plan=[];appendJingStack(b,plan,sourceHashes);sid=await b.run();
 console.log('View: https://stxer.xyz/simulations/mainnet/'+sid);const before=checks.length;
 const first=await getSimulationResult(sid);for(let i=0;i<plan.length;i++){step++;check(plan[i].label,decode(first.steps[i].Result),plan[i].want??ok);}
 await deploy('fastpool-swap-vault',resolve(root,'contracts/fastpool-swap-vault.clar'));
 await deploy('signer-manager-vault-stx-rewards',resolve(root,'contracts/signer-manager-vault-stx-rewards.clar'));
 return ()=>{runs.push({case:name,sid,url:'https://stxer.xyz/simulations/mainnet/'+sid,checks:checks.length-before,passed:checks.slice(before).filter(c=>c.passed).length});save();};
}
// One cycle's earned reward, claimed and sent into the vault through the real pool.
async function fundCycle(cycle,sats,expectFund=`(ok u${sats})`){
 await tx(`real sBTC backs cycle ${cycle} rewards`,SBTC,'transfer',[u(sats),cp(WHALE),cp(POX),Cl.none()],'(ok true)',WHALE);
 const key=`{reward-cycle:u${cycle},bond-index:none,signer:'${POOL}}`;
 await ev(`cycle ${cycle} earned ${sats} sats + mirrored share fixture`,POX,`(begin
   (map-set signer-shares-staked-for-cycle ${key} u1)
   (map-set signer-pending-staked-ustx-per-cycle {signer:'${POOL},cycle:u${cycle}} u1)
   (map-set signer-rewards-per-token-settled-for-cycle ${key} (get-rewards-per-token-for-cycle u${cycle} none))
   (map-set signer-unclaimed-rewards-for-cycle ${key} u${sats})
   (map-set staker-shares-staked-for-cycle {reward-cycle:u${cycle},bond-index:none,signer:'${POOL},staker:'${stranger}} u1)
   (var-set last-accounted-rewards-only (+ (var-get last-accounted-rewards-only) u${sats}))
   (try! (contract-call? '${POOL} validate-stake! '${stranger} u${cycle} u1 u1 u0 false none)) (ok true))`,'(ok true)');
 await tx(`pool claims cycle ${cycle}`,POOL,'claim-rewards',[u(cycle)],`(ok u${sats})`,stranger);
 return tx(`pool funds vault from cycle ${cycle}`,POOL,'fund-swap-vault',[u(cycle),cp(VAULT)],expectFund,stranger);
}
async function stxMaker(sats,mid,update){
 const amount=BigInt(sats)*mid/10000000000n;
 await tx(`real STX maker bid worth ~${sats} sats`,MARKET,'deposit-token-y',[u(amount),u(mid*105n/100n),Cl.none(),cp(WSTX),Cl.stringAscii('wstx')],`(ok u${amount})`,STX_WHALE);
 if(await ev('',MARKET,`(get-token-y-pending-deposit '${STX_WHALE})`)!=='none')await tx('settle STX maker',MARKET,'settle-token-y-deposit',[cp(STX_WHALE),update,cp(WSTX),Cl.stringAscii('wstx')],ok,stranger);
 check('STX maker bid is live',await ev('',MARKET,`(get-token-y-deposit (get-current-cycle) '${STX_WHALE})`),v=>uint(v)>0n);
}
function routing(r){const s=prints(r,ROUTER).find(p=>p.includes('smart-swap-sbtc-for-stx'));check('router print present',s??'missing',v=>v!=='missing');
 const g=n=>field(s,n);return {jingCap:g('jing-cap'),dlmmCap:g('dlmm-cap'),xykCap:g('xyk-cap'),velarCap:g('velar-cap'),jingIn:g('jing-in'),dlmmIn:g('dlmm-in'),xykIn:g('xyk-in'),velarIn:g('velar-in'),unsold:g('unsold'),out:g('out'),min:uint(s.match(/\(min-stx-out u\d+\)/)?.[0]??'u0')};}
const floorOut=(n,limit)=>n*limit/10000000000n;

// ---------------------------------------------------------------- L-1
async function l1(){
 const done=await session('fastpool/L-1 partial router sale');
 // 1,000,000 sats (the default max chunk): above what the book plus the AMMs can take
 // inside the 40 bps floor at the tip (about 720k on 2026-09-30); 100,000 no longer left a rest
 const cycle=Number(uint(await ev('',POX,'(current-pox-reward-cycle)')))-1,FUND=1000000n;
 // 40 bps floor: a fresh-print book fill (20 bps rebate) is inside it; AMM depth
 // inside 0.4% is what the pools happen to hold at the fork tip (logged caps, checked below)
 await tx('admin sets 40 bps floor',POOL,'set-vault-slippage-bps',[u(40),cp(VAULT)],'(ok true)');
 await fundCycle(cycle,FUND);
 await ev('vault holds the reward',MARKET,bal(VAULT),`u${FUND}`);
 await ev('fixture: patience window elapsed',VAULT,'(begin (var-set batch-start (some (- burn-block-height u288))) true)','true');
 let {update,mid}=await fresh();
 await stxMaker(40000,mid,update);
 ({update,mid}=await fresh());
 const stx0=uint(await ev('',MARKET,`(stx-get-balance '${VAULT})`));
 const r1=await tx('call 1: router-swap sells only what fits inside the floor',VAULT,'router-swap',[update],v=>ok(v)&&v.includes(`(amount u${FUND})`)&&field(v,'unsold')>0n,stranger);
 const res1=r1.result,limit=field(res1,'limit-price'),unsold1=field(res1,'unsold'),out1=field(res1,'out'),sold1=FUND-unsold1;
 const rt1=routing(r1);
 const cap1=rt1.jingCap+rt1.dlmmCap+rt1.xykCap+rt1.velarCap;
 check('call 1 capacity inside the floor (jing+dlmm+xyk+velar caps) is below the amount',`${rt1.jingCap}+${rt1.dlmmCap}+${rt1.xykCap}+${rt1.velarCap}=${cap1} < ${FUND}`,()=>cap1<FUND);
 check('call 1 unsold = amount - sold, sold <= capacity',`unsold ${unsold1}, sold ${sold1}, cap ${cap1}`,()=>unsold1===FUND-sold1&&sold1<=cap1);
 check('call 1 legs add up to what sold',`${rt1.jingIn}+${rt1.dlmmIn}+${rt1.xykIn}+${rt1.velarIn}=${sold1}, unsold ${rt1.unsold}`,()=>rt1.jingIn+rt1.dlmmIn+rt1.xykIn+rt1.velarIn===sold1&&rt1.unsold===unsold1);
 check('call 1 book leg filled',String(rt1.jingIn),v=>rt1.jingIn>0n);
 check('call 1 sold more than ROUTER_SLACK_SATS',String(sold1),v=>sold1>8n);
 check('call 1 out meets floor-out(sold - 8)',`${out1} >= ${floorOut(sold1-8n,limit)}`,()=>out1>=floorOut(sold1-8n,limit));
 await ev('call 1: exact unsold rest stays in the vault',MARKET,bal(VAULT),`u${unsold1}`);
 await ev('call 1: vault STX up by exactly out',MARKET,`(stx-get-balance '${VAULT})`,`u${stx0+out1}`);
 check('call 1 vault print matches router out/unsold',`${rt1.out}/${rt1.unsold}`,`${out1}/${unsold1}`);
 await ev('batch still open after partial sale',VAULT,'(get-clock)',v=>v.includes('(batch-start (some')&&v.includes('(ready-to-finish false)'));
 await tx('finalize refused while the rest is held',POOL,'finalize-swap-vault',[cp(VAULT)],'(err u16032)',stranger);
 await tx('same burn block: cooldown',VAULT,'router-swap',[update],'(err u16044)',stranger);
 await advance(1);
 ({update,mid}=await fresh());
 await stxMaker(30000,mid,update);
 ({update,mid}=await fresh());
 const r2=await tx('call 2: next call sells more of the rest',VAULT,'router-swap',[update],v=>ok(v)&&v.includes(`(amount u${unsold1})`),stranger);
 const unsold2=field(r2.result,'unsold'),out2=field(r2.result,'out'),sold2=unsold1-unsold2,limit2=field(r2.result,'limit-price');const rt2=routing(r2);
 check('call 2 sold more than ROUTER_SLACK_SATS',String(sold2),()=>sold2>8n);
 check('call 2 out meets floor-out(sold - 8)',`${out2} >= ${floorOut(sold2-8n,limit2)}`,()=>out2>=floorOut(sold2-8n,limit2));
 check('call 2 legs add up',`${rt2.jingIn}+${rt2.dlmmIn}+${rt2.xykIn}+${rt2.velarIn}=${sold2}`,()=>rt2.jingIn+rt2.dlmmIn+rt2.xykIn+rt2.velarIn===sold2&&rt2.unsold===unsold2);
 await ev('call 2: exact rest in the vault',MARKET,bal(VAULT),`u${unsold2}`);
 await ev('call 2: vault STX = out1 + out2',MARKET,`(stx-get-balance '${VAULT})`,`u${stx0+out1+out2}`);
 check('a rest is still held for the <= 8 sats case',String(unsold2),()=>unsold2>8n);
 // No book left; floor at the mid itself: no AMM leg can sell inside it, so the call sells 0 <= 8
 await advance(1);
 await tx('admin sets 0 bps floor (limit = mid)',POOL,'set-vault-slippage-bps',[u(0),cp(VAULT)],'(ok true)');
 ({update,mid}=await fresh());
 const lastBefore=await ev('',VAULT,'(get-config)');
 await tx('call 3: nothing inside the floor, sold <= 8 sats: u16047',VAULT,'router-swap',[update],'(err u16047)',stranger);
 await ev('call 3: vault sBTC unchanged',MARKET,bal(VAULT),`u${unsold2}`);
 await ev('call 3: vault STX unchanged',MARKET,`(stx-get-balance '${VAULT})`,`u${stx0+out1+out2}`);
 await ev('call 3: cooldown not burned (config unchanged)',VAULT,'(get-config)',lastBefore);
 await tx('call 3b: same block still accepted by cooldown gate, still u16047',VAULT,'router-swap',[update],'(err u16047)',stranger);
 done();
}

// ---------------------------------------------------------------- L-2 + #6
async function l2d6(){
 const done=await session('fastpool/L-2 window cap + #6 dust-only batch');
 const c=Number(uint(await ev('',POX,'(current-pox-reward-cycle)')));
 await tx('L-2: 289-block window refused (u16033)',POOL,'set-vault-window-blocks',[u(289),cp(VAULT)],'(err u16033)');
 await ev('L-2: window unchanged after refusal',VAULT,'(get-config)',v=>v.includes('(window-blocks u288)'));
 await tx('L-2: 1008-block window refused (u16033)',POOL,'set-vault-window-blocks',[u(1008),cp(VAULT)],'(err u16033)');
 const w0=await tx('L-2: 287-block window accepted',POOL,'set-vault-window-blocks',[u(287),cp(VAULT)],'(ok true)');
 check('L-2: set-window-blocks print u287',prints(w0,VAULT).join('|'),v=>v.includes('(notification "set-window-blocks")')&&v.includes('(value u287)'));
 const w=await tx('L-2: 288-block window accepted',POOL,'set-vault-window-blocks',[u(288),cp(VAULT)],'(ok true)');
 check('L-2: set-window-blocks print u288',prints(w,VAULT).join('|'),v=>v.includes('(value u288)'));
 await ev('L-2: window is 288',VAULT,'(get-config)',v=>v.includes('(window-blocks u288)'));
 // #6: a 2-sat claim funds a dust-only batch
 const f=await fundCycle(c-1,2n);
 check('#6: vault fund print amount u2',prints(f,VAULT).join('|'),v=>v.includes('(notification "fund")')&&v.includes('(amount u2)'));
 await ev('#6: vault holds exactly 2 sats',MARKET,bal(VAULT),'u2');
 await ev('#6: vault holds 0 STX',MARKET,`(stx-get-balance '${VAULT})`,'u0');
 await ev('#6: 2 sats count as empty',VAULT,'(is-empty)','true');
 await ev('#6: pool vault-cycle set',POOL,'(get-vault-cycle)',`(some u${c-1})`);
 const cb=await tx('#6: permissionless close-batch closes at once',VAULT,'close-batch',[],ok,stranger);
 check('#6: close-batch print',prints(cb,VAULT).join('|'),v=>v.includes('(notification "close-batch")'));
 await ev('#6: ready to finish, clock cleared',VAULT,'(get-clock)',v=>v.includes('(batch-start none)')&&v.includes('(ready-to-finish true)'));
 const poolStx=uint(await ev('',MARKET,`(stx-get-balance '${POOL})`));
 const fin=await tx('#6: finalize-swap-vault finishes with 0 STX',POOL,'finalize-swap-vault',[cp(VAULT)],'(ok u0)',stranger);
 const fp=prints(fin,VAULT).join('|');
 check('#6: finish print amount u0',fp,v=>v.includes('(notification "finish")')&&v.includes('(amount u0)'));
 check('#6: no STX transfer event in finish',JSON.stringify((fin.receipt?.events??[]).map(e=>typeof e==='string'?JSON.parse(e):e).filter(e=>e.stx_transfer_event)),'[]');
 await ev('#6: pool STX unchanged',MARKET,`(stx-get-balance '${POOL})`,`u${poolStx}`);
 await ev('#6: pool vault-cycle cleared',POOL,'(get-vault-cycle)','none');
 await ev('#6: vault not ready-to-finish any more',VAULT,'(get-clock)',v=>v.includes('(ready-to-finish false)')&&v.includes('(batch-start none)'));
 await ev('#6: the 2 dust sats stay in the vault',MARKET,bal(VAULT),'u2');
 await tx('#6: a second finalize is refused (u1053, no active cycle)',POOL,'finalize-swap-vault',[cp(VAULT)],'(err u1053)',stranger);
 // the next claim funds normally: no u1050
 const f2=await fundCycle(c-2,100000n);
 check('#6: next funding print amount u100000',prints(f2,VAULT).join('|'),v=>v.includes('(amount u100000)'));
 await ev('#6: vault holds new reward + carried dust',MARKET,bal(VAULT),'u100002');
 await ev('#6: new batch clock running',VAULT,'(get-clock)',v=>v.includes('(batch-start (some')&&v.includes('(window-open true)'));
 await ev('#6: pool vault-cycle now the next cycle',POOL,'(get-vault-cycle)',`(some u${c-2})`);
 done();
}

// ---------------------------------------------------------------- #7
async function d7(){
 const done=await session('fastpool/#7 market dust after sell-out');
 const c=Number(uint(await ev('',POX,'(current-pox-reward-cycle)'))),FUND=100000n;
 const swapArgs=(A,mid,update)=>[u(A),u(mid*105n/100n),update,cp(SBTC),Cl.stringAscii('sbtc-token'),cp(WSTX),Cl.stringAscii('wstx'),Cl.bool(false)];
 async function finalize(label){const stx=uint(await ev('',MARKET,`(stx-get-balance '${VAULT})`));const poolStx=uint(await ev('',MARKET,`(stx-get-balance '${POOL})`));
  await tx(label+': pool finalizes exactly the sale STX',POOL,'finalize-swap-vault',[cp(VAULT)],`(ok u${stx})`,stranger);
  await ev(label+': pool received exactly the sale STX',MARKET,`(- (stx-get-balance '${POOL}) u${poolStx})`,`u${stx}`);
  await ev(label+': vault STX 0 after finish',MARKET,`(stx-get-balance '${VAULT})`,'u0');
  await ev(label+': pool vault-cycle cleared',POOL,'(get-vault-cycle)','none');}
 // Batch 1 - the reported trigger: full sell-out, then 1 donated sat + public jing-place
 await fundCycle(c-1,FUND);
 let {update,mid}=await fresh();
 await tx('batch 1: vault places its ask',VAULT,'jing-place',[update],v=>ok(v)&&v.includes(`(amount u${FUND})`),stranger);
 await ev('batch 1: ask is live',MARKET,live,`u${FUND}`);
 await tx('batch 1: real maker depth behind the vault ask',MARKET,'deposit-token-x',[u(FUND),u(mid*101n/100n),Cl.none(),cp(SBTC),Cl.stringAscii('sbtc-token')],`(ok u${FUND})`,WHALE);
 ({update,mid}=await fresh());
 await tx('batch 1: real STX taker buys the whole ask',MARKET,'swap',swapArgs(FUND*mid/10000000000n*150n/100n,mid,update),ok,STX_WHALE);
 await ev('batch 1: sold out, live 0',MARKET,live,'u0');
 await ev('batch 1: sold out, wallet 0 sBTC',MARKET,bal(VAULT),'u0');
 await ev('batch 1: window still open',VAULT,'(get-clock)',v=>v.includes('(window-open true)')&&v.includes('(batch-start (some'));
 await tx('batch 1: griefer sends 1 sat',SBTC,'transfer',[u(1),cp(WHALE),cp(VAULT),Cl.none()],'(ok true)',WHALE);
 ({update,mid}=await fresh());
 // v6-3 checks min-token-x-deposit on existing + parked + amount: 0 + 0 + 1 < 1000
 await tx('batch 1: 1-sat jing-place refused by the market minimum (u1001)',VAULT,'jing-place',[update],'(err u1001)',stranger);
 await ev('batch 1: nothing reached the market',MARKET,`(+ ${live} ${parked} ${pending})`,'u0');
 await ev('batch 1: donated sat is wallet dust, is-empty true',VAULT,'(is-empty)','true');
 const cb1=await tx('batch 1: close-batch closes at once',VAULT,'close-batch',[],ok,stranger);
 check('batch 1: close-batch prints no reclaim',prints(cb1,VAULT).join('|'),v=>v.includes('(notification "close-batch")')&&!v.includes('jing-reclaim'));
 await ev('batch 1: ready to finish',VAULT,'(get-clock)',v=>v.includes('(batch-start none)')&&v.includes('(ready-to-finish true)'));
 await finalize('batch 1');
 await ev('batch 1: the donated sat rides on',MARKET,bal(VAULT),'u1');
 // At the production minimum (1,000 sats) the market refuses the 1-sat top-up, and a
 // settlement rolls any maker remainder under the minimum, so market dust of <= 2 sats
 // cannot form. The fix is defensive; to reach its branch the operator lowers the
 // market minimum to 1 sat with the market's public setter (fork only).
 await tx('operator lowers min-token-x-deposit to 1 sat',MARKET,'set-min-token-x-deposit',[u(1)],'(ok true)');
 async function sellOut(label,cycle,expectHeld){
  await fundCycle(cycle,FUND);
  let {update,mid}=await fresh();
  await tx(label+': vault places its ask',VAULT,'jing-place',[update],v=>ok(v)&&v.includes(`(amount u${expectHeld})`),stranger);
  await tx(label+': real maker depth behind the vault ask',MARKET,'deposit-token-x',[u(FUND),u(mid*101n/100n),Cl.none(),cp(SBTC),Cl.stringAscii('sbtc-token')],`(ok u${FUND})`,WHALE);
  ({update,mid}=await fresh());
  await tx(label+': real STX taker buys the whole ask',MARKET,'swap',swapArgs(FUND*mid/10000000000n*150n/100n,mid,update),ok,STX_WHALE);
  await ev(label+': sold out, market position 0',MARKET,`(+ ${live} ${parked} ${pending})`,'u0');
  await ev(label+': sold out, wallet 0',MARKET,bal(VAULT),'u0');
  await ev(label+': window still open',VAULT,'(get-clock)',v=>v.includes('(window-open true)')&&v.includes('(batch-start (some'));
  await tx(label+': whale depth cancelled',MARKET,'cancel-token-x-deposit',[cp(SBTC),Cl.stringAscii('sbtc-token')],ok,WHALE);
 }
 async function griefPlace(label,sats){
  await tx(`${label}: griefer sends ${sats} sat(s)`,SBTC,'transfer',[u(sats),cp(WHALE),cp(VAULT),Cl.none()],'(ok true)',WHALE);
  const {update}=await fresh();
  await tx(`${label}: public jing-place of ${sats} sat(s) accepted`,VAULT,'jing-place',[update],v=>ok(v)&&v.includes(`(amount u${sats})`),stranger);
  await ev(`${label}: ${sats} sat(s) on the market (live + parked + pending)`,MARKET,`(+ ${live} ${parked} ${pending})`,`u${sats}`);
  await ev(`${label}: wallet 0`,MARKET,bal(VAULT),'u0');
  await ev(`${label}: market position makes is-empty false`,VAULT,'(is-empty)','false');
 }
 // Batch 2 - the fix: 1 sat on the market after a sell-out
 await sellOut('batch 2',c-2,FUND+1n);
 await ev('batch 2: carried sat went out with the ask',MARKET,bal(VAULT),'u0');
 await griefPlace('batch 2',1);
 const cb=await tx('batch 2: close-batch cancels the 1 sat home and closes at once',VAULT,'close-batch',[],ok,stranger);
 const cbp=prints(cb,VAULT).join('|');
 check('batch 2: close-batch prints jing-reclaim amount u1 then close-batch',cbp,v=>v.includes('(notification "jing-reclaim")')&&v.includes('(amount u1)')&&v.includes('(notification "close-batch")'));
 const ft=(cb.receipt?.events??[]).map(e=>typeof e==='string'?JSON.parse(e):e).filter(e=>e.ft_transfer_event).map(e=>e.ft_transfer_event);
 check('batch 2: exactly one 1-sat sBTC transfer market -> vault',JSON.stringify(ft.map(e=>[e.sender,e.recipient,e.amount])),JSON.stringify([[MARKET,VAULT,'1']]));
 await ev('batch 2: market position cleared',MARKET,`(+ ${live} ${parked} ${pending})`,'u0');
 await ev('batch 2: the sat is home as wallet dust',MARKET,bal(VAULT),'u1');
 await ev('batch 2: batch closed, ready to finish',VAULT,'(get-clock)',v=>v.includes('(batch-start none)')&&v.includes('(ready-to-finish true)'));
 await finalize('batch 2');
 // Batch 3 - control: a 3-sat position (> DUST_SATS) is never cancelled by close-batch
 await sellOut('batch 3',c-3,FUND+1n);
 await griefPlace('batch 3',3);
 await tx('batch 3: close-batch refuses a real 3-sat position (u16043)',VAULT,'close-batch',[],'(err u16043)',stranger);
 await ev('batch 3: 3 sats still on the market',MARKET,`(+ ${live} ${parked} ${pending})`,'u3');
 await ev('batch 3: batch still open',VAULT,'(get-clock)',v=>v.includes('(batch-start (some')&&v.includes('(ready-to-finish false)'));
 done();
}

// ---------------------------------------------------------------- Pyth Lazer fee budget
// Pyth Lazer charges its per-update fee from tx-sender, which is the vault inside
// as-contract?. The live fee is u0; the fixture var-sets it to u10 in the oracle's
// own context (fork only). At budget 0 with no STX, jing-take aborts and the router
// catches the market's failure (`match`), dropping the Jing book leg (AMMs only).
// At budget 0 with STX held, both abort on the with-stx allowance. The market's swap
// verifies the update once inside as-contract? and reuses the feeds, so both paths
// need a budget of one fee: they abort at u9 (fee - 1), pass at u10.
async function pf(){
 const done=await session('fastpool/Pyth Lazer fee budget');
 const ORACLE='SPMV5HDZ4EMB8XY7HAYT3XW0DF7DZ4E8XEG2J1T8.pyth-lazer-oracle',FEE=10n;
 const cycle=Number(uint(await ev('',POX,'(current-pox-reward-cycle)')))-1,FUND=150000n,CHUNK=50000n;
 const stxOf=who=>ev('',MARKET,`(stx-get-balance '${who})`).then(uint);
 async function evAs(label,sender,id,code,expect){const r=await submitSimulationSteps(sid,{steps:[{Eval:[sender,'',id,code]}]});step++;const v=decode(r.steps[0]);check(label,v,expect);return v;}
 const vaultStxOut=r=>(r.receipt?.events??[]).map(e=>typeof e==='string'?JSON.parse(e):e).filter(e=>e.stx_transfer_event&&e.stx_transfer_event.sender===VAULT).map(e=>[e.stx_transfer_event.recipient,e.stx_transfer_event.amount]);
 await ev('pyth fee budget starts at 0',VAULT,'(get-config)',v=>v.includes('(pyth-fee-budget u0)'));
 await tx('chunk cap 50k: router, jing-take, router',POOL,'set-vault-max-chunk-sats',[u(CHUNK),cp(VAULT)],'(ok true)');
 // 10% floor: the AMM-only sale at budget 0 must not depend on how deep the pools are at the tip
 await tx('admin sets 1000 bps floor',POOL,'set-vault-slippage-bps',[u(1000),cp(VAULT)],'(ok true)');
 await fundCycle(cycle,FUND);
 await ev('fixture: patience window elapsed',VAULT,'(begin (var-set batch-start (some (- burn-block-height u288))) true)','true');
 let {update,mid}=await fresh();
 // one deep STX bid (placed while the fee is still 0) serves the router book leg and jing-take
 await stxMaker(300000,mid,update);
 const recipient=await ev('live oracle fee recipient',ORACLE,'(var-get fee-recipient)',v=>/^S[A-Z0-9]+(\.[a-z0-9-]+)?$/.test(v));
 await ev('live oracle fee is u0',ORACLE,'(var-get fee)','u0');
 await ev('fixture: oracle fee set to u10 in the oracle context (fork only)',ORACLE,`(begin (var-set fee u${FEE}) (var-get fee))`,`u${FEE}`);
 ({update,mid}=await fresh());
 await ev('vault holds 0 STX before the float',MARKET,`(stx-get-balance '${VAULT})`,'u0');
 // budget 0, no STX float: the market's fee transfer fails for lack of balance
 await tx('budget 0, no float: admin jing-take aborts (u1, fee transfer fails)',POOL,'jing-take',[u(CHUNK),update,cp(VAULT)],'(err u1)');
 let stx0=await stxOf(VAULT);
 const r0=await tx('budget 0, no float: router-swap still sells, AMMs only',VAULT,'router-swap',[update],v=>ok(v)&&v.includes(`(amount u${CHUNK})`),STX_WHALE);
 const rt0=routing(r0);
 check('budget 0, no float: router drops the Jing book leg (jing-ok false, jing-in 0)',prints(r0,ROUTER).join('|'),v=>v.includes('(jing-ok false)')&&rt0.jingIn===0n&&rt0.jingCap>0n);
 check('budget 0, no float: vault paid no STX',JSON.stringify(vaultStxOut(r0)),'[]');
 await ev('budget 0, no float: vault STX = out',MARKET,`(stx-get-balance '${VAULT})`,`u${stx0+field(r0.result,'out')}`);
 // budget 0 with STX on hand: the fee transfer succeeds, then the vault's with-stx
 // allowance (index 1) rejects the whole as-contract? body, router included
 await advance(1);
 ({update,mid}=await fresh());
 await evAs('fixture: STX whale tops the vault up by 1000 uSTX',STX_WHALE,MARKET,`(stx-transfer? u1000 tx-sender '${VAULT})`,'(ok true)');
 const held=await stxOf(VAULT);
 await tx('budget 0, STX held: admin jing-take aborts (u1, with-stx allowance)',POOL,'jing-take',[u(CHUNK),update,cp(VAULT)],'(err u1)');
 await tx('budget 0, STX held: router-swap aborts (u1, with-stx allowance)',VAULT,'router-swap',[update],'(err u1)',STX_WHALE);
 await tx('budget 0, STX held: admin router-swap-split (all Jing) aborts (u1, with-stx allowance)',POOL,'router-swap-split',[u(CHUNK),u(CHUNK),u(0),u(0),u(0),update,cp(VAULT)],'(err u1)');
 await ev('budget 0: nothing more sold',MARKET,bal(VAULT),`u${FUND-CHUNK}`);
 await ev('budget 0: vault STX unchanged',MARKET,`(stx-get-balance '${VAULT})`,`u${held}`);
 const setBudget=async(b)=>{const r=await tx(`admin sets pyth fee budget u${b}`,POOL,'set-vault-pyth-fee-budget',[u(b),cp(VAULT)],'(ok true)');
  check(`set-pyth-fee-budget print u${b}`,prints(r,VAULT).join('|'),v=>v.includes('(notification "set-pyth-fee-budget")')&&v.includes(`(value u${b})`));
  await ev(`get-config reports budget u${b}`,VAULT,'(get-config)',v=>v.includes(`(pyth-fee-budget u${b})`));};
 // Inside as-contract? the market's swap verifies the update once and reuses the feeds,
 // on both jing-take and the router book leg: fee - 1 of budget is not enough, one fee is
 await setBudget(FEE-1n);
 ({update,mid}=await fresh());
 stx0=await stxOf(VAULT);
 await tx(`budget u${FEE-1n} (fee - 1): admin jing-take aborts (u1), the swap pays one fee`,POOL,'jing-take',[u(CHUNK),update,cp(VAULT)],'(err u1)');
 await tx(`budget u${FEE-1n} (fee - 1): router-swap aborts (u1), the book leg pays one fee`,VAULT,'router-swap',[update],'(err u1)',STX_WHALE);
 await ev(`budget u${FEE-1n} aborts: sBTC and STX unchanged`,MARKET,`{ sbtc: ${bal(VAULT)}, stx: (stx-get-balance '${VAULT}) }`,`(tuple (sbtc u${FUND-CHUNK}) (stx u${stx0}))`);
 await setBudget(FEE);
 const oneFee=JSON.stringify([[recipient,String(FEE)]]);
 const r2=await tx(`budget u${FEE} (1 fee): admin jing-take sells a 50k chunk on the book`,POOL,'jing-take',[u(CHUNK),update,cp(VAULT)],v=>ok(v)&&v.includes(`(amount u${CHUNK})`));
 check(`jing-take: vault paid exactly one u${FEE} fee to the oracle recipient`,JSON.stringify(vaultStxOut(r2)),oneFee);
 await ev('jing-take: vault STX = before + out - 1 fee',MARKET,`(stx-get-balance '${VAULT})`,`u${stx0+field(r2.result,'out')-FEE}`);
 await ev('jing-take: 50k sBTC left for the router',MARKET,bal(VAULT),`u${CHUNK}`);
 ({update,mid}=await fresh());
 stx0=await stxOf(VAULT);
 const r1=await tx(`budget u${FEE} (1 fee): router-swap sells the last 50k chunk`,VAULT,'router-swap',[update],v=>ok(v)&&v.includes(`(amount u${CHUNK})`),STX_WHALE);
 const rt1=routing(r1);
 check(`budget u${FEE}: router fills the Jing book leg`,prints(r1,ROUTER).join('|'),v=>v.includes('(jing-ok true)')&&rt1.jingIn>0n);
 check(`router-swap: vault paid exactly one u${FEE} fee to the oracle recipient`,JSON.stringify(vaultStxOut(r1)),oneFee);
 // the router measures out as the vault's STX balance change, so its out is net of the fees
 check('router out = Jing leg out - 1 fee',String(field(r1.result,'out')),String(field(prints(r1,ROUTER).join('|'),'jing-out')-FEE));
 await ev('router-swap: vault STX = before + out (net of fees)',MARKET,`(stx-get-balance '${VAULT})`,`u${stx0+field(r1.result,'out')}`);
 await ev('vault sold out and closed',VAULT,'(get-clock)',v=>v.includes('(batch-start none)')&&v.includes('(ready-to-finish true)'));
 const fin=await stxOf(VAULT);
 await tx('pool finalizes the whole STX balance (float included)',POOL,'finalize-swap-vault',[cp(VAULT)],`(ok u${fin})`,stranger);
 done();
}

const all={l1,l2d6,d7,pf};
for(const [k,f] of Object.entries(all))if(!want.length||want.includes(k))await f();
save();
console.log(`${checks.filter(c=>c.passed).length}/${checks.length} checks green`);for(const r of runs)console.log(`${r.case}: ${r.passed}/${r.checks} ${r.url}`);
