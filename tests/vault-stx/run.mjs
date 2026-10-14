// Isolated runtime tests for both current production drafts.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import assert from 'node:assert/strict';
const testDir=dirname(fileURLToPath(import.meta.url));
const projectRoot=resolve(testDir,'../..');
let require=createRequire(resolve(projectRoot,'package.json'));
try { require.resolve('@stacks/clarinet-sdk'); }
catch { require=createRequire(resolve(projectRoot,'../jing-contracts-v3/package.json')); }
const { initSimnet, tx }=require('@stacks/clarinet-sdk');
const { Cl, cvToString }=require('@stacks/transactions');
const manifest=resolve(testDir,'.build/Clarinet.toml');
const sim=await initSimnet(manifest,true);
const accounts=sim.getAccounts(), admin=accounts.get('deployer'), alice=accounts.get('wallet_1'), bob=accounts.get('wallet_2');
const cp=n=>Cl.contractPrincipal(admin,n),u=Cl.uint, update=Cl.buffer(new Uint8Array());
const juiceVaultFunctions=new Set(['pox-claim-rewards','finalize-swap','emergency-recover','refloor-vault','set-vault-window-blocks','set-vault-leeway-bps','set-vault-slippage-bps','set-vault-max-chunk-sats','set-vault-dia-band-bps','set-vault-router-cooldown','set-vault-no-pyth-slippage-bps','jing-take','router-swap-split','router-swap-split-dia']);
const fastpoolVaultFunctions=new Set(['fund-swap-vault','finalize-swap-vault','recover-swap-vault','refloor-vault','set-vault-window-blocks','set-vault-leeway-bps','set-vault-slippage-bps','set-vault-max-chunk-sats','set-vault-dia-band-bps','set-vault-router-cooldown','set-vault-no-pyth-slippage-bps','jing-take','router-swap-split','router-swap-split-dia']);
const withVault=(n,f,a)=>n===J&&juiceVaultFunctions.has(f)?[...a,cp(JV)]:n===F&&fastpoolVaultFunctions.has(f)?[...a,cp(FV)]:a;
function call(n,f,a=[],sender=alice){
 const result=sim.callPublicFn(n,f,withVault(n,f,a),sender);
 if(result.result.type==='ok'){
  for(const event of eventChecks[`${n}.${f}`]||[]){
   assert.ok(result.events.some(e=>e.data?.value&&cvToString(e.data.value).includes(`"${event}"`)),`Missing ${event} event`);
  }
 }
 return result;
}
function ok(r){assert.equal(r.result.type,'ok',cvToString(r.result));return r.result.value}
function err(r,code){assert.equal(cvToString(r.result),`(err u${code})`)}
function read(n,f,a=[]){return sim.callReadOnlyFn(n,f,a,admin).result}
function stx(w){return sim.getAssetsMap().get('STX').get(w)||0n}
const J='juice-pool-stx-signer-stx-rewards',JV='juice-pool-swap-vault',F='fastpool-stx-vault-signer',FV='fastpool-swap-vault',FVN='fastpool-swap-vault-next';
const eventChecks={
 [`${J}.propose-admin`]:['propose-admin'],
 [`${J}.accept-admin`]:['accept-admin'],
 [`${J}.cancel-admin-proposal`]:['cancel-admin-proposal'],
 [`${J}.pox-claim-rewards`]:['fund','claim-rewards'],
 [`${J}.finalize-swap`]:['finish','finalize-swap'],
 [`${J}.emergency-recover`]:['emergency-recover'],
 [`${J}.pay-recovered-sbtc-stakers`]:['pay-recovered-sbtc-stakers'],
 [`${J}.sweep-recovered-sbtc-dust`]:['sweep-recovered-sbtc-dust'],
 [`${J}.withdraw-sbtc-fees`]:['withdraw-sbtc-fees'],
 [`${J}.refloor-vault`]:['jing-refloor'],
 [`${F}.recover-swap-vault`]:['emergency-recover','recover-swap-vault'],
};
for(const setting of ['window-blocks','leeway-bps','slippage-bps','max-chunk-sats','dia-band-bps','router-cooldown']){
 eventChecks[`${J}.set-vault-${setting}`]=[`set-${setting}`];
}

ok(sim.transferSTX(Cl.uint(50000000000).value,`${admin}.mock-router`,admin));
// New Juice admin controls: every setting checks caller and its upper bound.
for(const [name,value,max,positive] of [
 ['window-blocks',288,288,false],['leeway-bps',500,1000,false],
 ['slippage-bps',100,1000,false],['max-chunk-sats',1000000,100000000,true],
 ['dia-band-bps',1000,5000,false],['router-cooldown',1,144,false]]){
 err(call(JV,`set-${name}`,[u(value)],admin),16000);
 err(call(J,`set-vault-${name}`,[u(value)]),100);
 err(call(J,`set-vault-${name}`,[u(max+1)],admin),16033);
 if(positive)err(call(J,`set-vault-${name}`,[u(0)],admin),16033);
 ok(call(J,`set-vault-${name}`,[u(max)],admin));
 ok(call(J,`set-vault-${name}`,[u(value)],admin));
}
const split=[u(500000),u(100000),u(100000),u(100000),u(200000),update];
err(call(JV,'router-swap-split',split,admin),16000);
err(call(J,'router-swap-split',split),100);

for(const [pool,vault,cycle] of [[J,JV,140],[F,FV,141]]){
 for(const [who,amount] of [[alice,1],[bob,3]])ok(call('mock-pox','stake-test',[cp(pool),Cl.principal(who),u(cycle),u(amount)]));
 err(call(vault,'fund',[u(1)]),16000);
 if(pool===J){ok(call(pool,'pox-claim-rewards',[Cl.list([]),u(cycle)]));err(call(pool,'pay-stx-stakers',[Cl.list([Cl.principal(alice)]),u(cycle),u(0)]),115);}
 else{ok(call(pool,'claim-rewards',[u(cycle)]));ok(call(pool,'fund-swap-vault',[u(cycle)]));err(call(pool,'fund-swap-vault',[u(cycle)]),1050);}
 if(pool===J){
  const clock=cvToString(read(JV,'get-clock'));
  err(call(J,'set-vault-window-blocks',[u(1)],admin),16045);
  assert.equal(cvToString(read(JV,'get-clock')),clock);
  err(call(J,'router-swap-split',split,admin),16031);
  err(call(J,'jing-take',[u(100000),update],admin),16031);
 }
 err(call(vault,'finish'),16000);
 err(call(vault,'router-swap',[update]),16031);
 ok(call(vault,'jing-place',[update]));
 err(call(vault,'jing-reclaim'),16031);
 err(call(pool,pool===J?'finalize-swap':'finalize-swap-vault'),16032);
 sim.mineEmptyBurnBlocks(288);
 ok(call(vault,'jing-reclaim'));
 // DIA divergence and staleness fail closed.
 ok(call('mock-dia','set-skew',[u(13000)]));
 err(call(vault,'router-swap',[update]),16037);
 ok(call('mock-dia','set-skew',[u(10000)]));
 ok(call('mock-dia','set-stale',[Cl.bool(true)]));
 err(call(vault,'router-swap',[update]),16036);
 ok(call('mock-dia','set-stale',[Cl.bool(false)]));
 // Two sales in the same burn block: exactly one succeeds.
 if(pool===J){
  err(call(J,'router-swap-split',[u(500001),...split.slice(1)],admin),16040);
  err(call(J,'router-swap-split',[u(1000001),u(1000001),u(0),u(0),u(0),update],admin),16039);
 }
 // router-swap sells min(balance, cap): a 500k cap keeps the 1M batch at two chunks
 if(pool===F)ok(call(F,'set-vault-max-chunk-sats',[u(500000)],admin));
 const first=pool===J?tx.callPublicFn(J,'router-swap-split',withVault(J,'router-swap-split',split),admin):tx.callPublicFn(vault,'router-swap',[update],alice);
 const batch=sim.mineBlock([first,tx.callPublicFn(vault,'router-swap',[update],bob)]);
 ok(batch[0]);err(batch[1],16044);
 err(call(pool,pool===J?'finalize-swap':'finalize-swap-vault'),16032);
 sim.mineEmptyBurnBlock();ok(call(vault,'router-swap',[update]));
 if(pool===F)ok(call(F,'set-vault-max-chunk-sats',[u(1000000)],admin));
 const final=ok(call(pool,pool===J?'finalize-swap':'finalize-swap-vault'));
 assert.equal(final.value,3200000000n);
 const a=stx(alice),b=stx(bob);
 if(pool===J){ok(call(pool,'pay-stx-stakers',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(cycle),u(0)]));}
 else{ok(call(pool,'distribute-rewards-many',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(cycle)]));}
 assert.equal(stx(alice)-a,800000000n);assert.equal(stx(bob)-b,2400000000n);
 const paid=stx(alice);
 if(pool===J)ok(call(pool,'pay-stx-stakers',[Cl.list([Cl.principal(alice)]),u(cycle),u(0)]));
 else err(call(pool,'distribute-rewards',[Cl.principal(alice),u(cycle)]),1013);
 assert.equal(stx(alice),paid);
 assert.equal(cvToString(read(vault,'get-clock')).includes('(batch-start none)'),true);
 console.log(`${pool}: resting -> reclaim -> two router chunks -> STX 1:3 payouts; guards and replay passed`);
}
// Maker fill during patience, plus Juice OG exemption and native STX fees.
for(const [who,amount] of [[alice,1],[bob,3]])ok(call('mock-pox','stake-test',[cp(J),Cl.principal(who),u(142),u(amount)]));
ok(call(J,'propose-fee-bips',[u(500)],admin));sim.mineEmptyBurnBlocks(144);ok(call(J,'confirm-fee-bips',[],admin));ok(call(J,'set-og',[Cl.principal(alice),Cl.bool(true)],admin));
ok(call(J,'pox-claim-rewards',[Cl.list([]),u(142)]));ok(call(JV,'jing-place',[update]));
err(call(JV,'close-batch'),16043);
err(call(JV,'jing-refloor',[update]),16000);err(call(J,'refloor-vault',[update]),100);ok(call(J,'refloor-vault',[update],admin));
ok(call('v6-market','swap',[u(3206412825),u(32000000000000),update,cp('mock-ft'),Cl.stringAscii('mock-ft'),cp('mock-ft'),Cl.stringAscii('mock-ft'),Cl.bool(false)],bob));
ok(call(JV,'close-batch'));
err(call(JV,'close-batch'),16032);
const makerOut=ok(call(J,'finalize-swap')).value;assert.equal(makerOut,3203212825n);
const aliceMaker=makerOut/4n, bobMaker=makerOut*3n/4n, juiceFee=bobMaker/20n;
let a=stx(alice),b=stx(bob);
ok(call(J,'pay-stx-stakers',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(142),u(0)]));
assert.equal(stx(alice)-a,aliceMaker);assert.equal(stx(bob)-b,bobMaker-juiceFee);
assert.equal(read(J,'get-earned-fees').value,juiceFee);
err(call(J,'withdraw-fees',[u(juiceFee+1n),Cl.principal(admin)],admin),111);
ok(call(J,'withdraw-all-fees',[Cl.principal(admin)],admin));
console.log('Juice: maker fill during patience, +10bps proceeds, OG exemption and native STX fee withdrawal passed');
// FastPool fees snapshot survives rate change and late claims do not mix batches.
ok(call(F,'update-fees',[u(500)],admin));ok(call('mock-pox','set-cycle',[u(152)]));
for(const [who,amount] of [[alice,1],[bob,3]])ok(call('mock-pox','stake-test',[cp(F),Cl.principal(who),u(149),u(amount)]));
ok(call(F,'claim-rewards',[u(149)]));ok(call(F,'update-fees',[u(0)],admin));
for(let batch=0;batch<2;batch++){
 ok(call(F,'fund-swap-vault',[u(149)]));
 assert.equal(read(F,'get-earned-fees').value,BigInt((batch+1)*50000));
 if(batch===0)ok(call(F,'claim-rewards',[u(149)]));
 sim.mineEmptyBurnBlocks(288);ok(call(FV,'router-swap',[update]));
 assert.equal(ok(call(F,'finalize-swap-vault')).value,3040000000n);
 a=stx(alice);b=stx(bob);
 ok(call(F,'distribute-rewards-many',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(149)]));
 assert.equal(stx(alice)-a,760000000n);assert.equal(stx(bob)-b,2280000000n);
}
assert.equal(read(F,'get-unswapped-sats').value,0n);assert.equal(read(F,'get-unpaid-stx').value,0n);
err(call(F,'withdraw-fees',[u(100001),Cl.principal(admin)],admin),1005);
ok(call(F,'withdraw-fees',[u(100000),Cl.principal(admin)],admin));
console.log('FastPool: snapshotted sBTC fees, late-claim batch isolation and incremental STX payouts passed');
// FastPool preserves Friedger's timed fallback through vault recovery.
ok(call(F,'update-fees',[u(500)],admin));
for(const [who,amount] of [[alice,1],[bob,3]])ok(call('mock-pox','stake-test',[cp(F),Cl.principal(who),u(150),u(amount)]));
ok(call(F,'claim-rewards',[u(150)]));ok(call(F,'fund-swap-vault',[u(150)]));
err(call(F,'recover-swap-vault'),1052);sim.mineEmptyBurnBlocks(433);
ok(call(F,'recover-swap-vault'));
assert.equal(read(F,'get-unswapped-for-cycle',[u(150)]).value,950000n);
const ftBalance=who=>ok({result:read('mock-ft','get-balance',[Cl.principal(who)])}).value;
let af=ftBalance(alice),bf=ftBalance(bob);
ok(call(F,'distribute-rewards-many',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(150)]));
assert.equal(ftBalance(alice)-af,237500n);assert.equal(ftBalance(bob)-bf,712500n);
assert.equal(read(F,'get-unswapped-sats').value,0n);
assert.equal(read(F,'get-earned-fees').value,50000n);
console.log('FastPool: expired vault returns unsold sBTC for original 1:3 mixed-asset payout with no second fee passed');
// Maker rounding residue is sweepable only after all stakers were paid.
assert.equal(ok(call(J,'sweep-tranche-dust',[u(142),u(0)],admin)).value,1n);
// A third-party sBTC donation cannot strand the next funding before it starts.
ok(call('mock-ft','mint',[u(7),cp(JV)]));
ok(call('mock-pox','stake-test',[cp(J),Cl.principal(alice),u(143),u(1)]));
ok(call(J,'pox-claim-rewards',[Cl.list([]),u(143)]));
assert.equal(ok({result:read('mock-ft','get-balance',[cp(JV)])}).value,1000007n);
ok(call('mock-pox','next-dist'));
err(call(J,'pox-claim-rewards',[Cl.list([]),u(143)]),115);
assert.equal(ok({result:read('mock-ft','get-balance',[cp(JV)])}).value,1000007n);
console.log('Juice: rounding dust, donation-safe funding and overlapping-batch rollback passed');
console.log('Juice: bounded admin setters, stable active deadline, split allocation, phase, chunk and shared cooldown guards passed');

// Direct Jing liquidation uses the admin wrapper and keeps the batch pending.
err(call(JV,'jing-take',[u(1000007),update],admin),16000);
err(call(J,'jing-take',[u(1000007),update]),100);
sim.mineEmptyBurnBlocks(288);
err(call(J,'jing-take',[u(0),update],admin),16006);
err(call(J,'jing-take',[u(1000008),update],admin),16006);
ok(call('v6-market','deposit-token-y',[u(4000000000),u(32000000000000),Cl.some(u(0)),update,cp('mock-ft'),Cl.stringAscii('mock-ft')],bob));
const beforeTake=stx(`${admin}.${JV}`);
const taken=ok(call(J,'jing-take',[u(1000007),update],admin));
const received=taken.value.payload.value.out.value;
assert.ok(received>0n);
assert.equal(stx(`${admin}.${JV}`)-beforeTake,received);
assert.equal(cvToString(read(JV,'is-empty')),'true');
assert.equal(cvToString(read(JV,'get-clock')).includes('(ready-to-finish true)'),true);
assert.equal(read(J,'get-pending-swap').type,'some');
assert.equal(ok(call(J,'finalize-swap')).value,received);
assert.equal(cvToString(read(JV,'get-clock')).includes('(batch-start none)'),true);
console.log('Juice: admin Jing take, native STX receipt, closed batch and finalization passed');

// Emergency recovery: fixed age, only admin, no oracle, paused Jing withdrawals.
const ft=w=>ok({result:read('mock-ft','get-balance',[Cl.principal(w)])}).value;
err(call(JV,'emergency-recover',[],admin),16000);
err(call(J,'emergency-recover'),100);
err(call(J,'emergency-recover',[],admin),115);
err(call(J,'pay-recovered-sbtc-stakers',[Cl.list([Cl.principal(alice)]),u(143),u(0)]),116);
// Remove the remaining bid from the previous Jing-take test.
ok(call('v6-market','cancel-token-y-deposit',[cp('mock-ft'),Cl.stringAscii('mock-ft')],bob));
for(const [cycle,kind] of [[160,'resting'],[161,'parked'],[162,'mixed'],[163,'stx-only']]){
 for(const [who,amount] of [[alice,1],[bob,3]])ok(call('mock-pox','stake-test',[cp(J),Cl.principal(who),u(cycle),u(amount)]));
 ok(call('mock-pox','next-dist'));
 ok(call(J,'pox-claim-rewards',[Cl.list([]),u(cycle)]));
 const start=Number(read(JV,'get-clock').value['batch-start'].value.value);
 err(call(J,'emergency-recover',[],admin),16046);
 err(call(J,'pay-recovered-sbtc-stakers',[Cl.list([Cl.principal(alice)]),u(cycle),u(0)]),116);
 if(kind==='resting'||kind==='parked'||kind==='stx-only'){
  ok(call(JV,'jing-place',[update]));
  if(kind==='parked'){
   ok(call('v6-market','rv-park-x-for-test',[cp(JV)],admin));
   assert.equal(read('v6-market','get-token-x-parked',[cp(JV)]).value,1000000n);
  }
 }
 if(kind==='mixed'){
  sim.mineEmptyBurnBlocks(288);
  // half the batch: router-swap sells min(balance, cap)
  ok(call(J,'set-vault-max-chunk-sats',[u(500000)],admin));
  ok(call(JV,'router-swap',[update]));
  ok(call(J,'set-vault-max-chunk-sats',[u(1000000)],admin));
 }
 if(kind==='stx-only'){
  ok(call('v6-market','swap',[u(3206412825),u(32000000000000),update,cp('mock-ft'),Cl.stringAscii('mock-ft'),cp('mock-ft'),Cl.stringAscii('mock-ft'),Cl.bool(false)],bob));
 }
 sim.mineEmptyBurnBlocks(start+431-sim.burnBlockHeight);
 err(call(J,'emergency-recover',[],admin),16046);
 sim.mineEmptyBurnBlock();
 // Oracle disagreement cannot obstruct the emergency exit.
 ok(call('mock-dia','set-skew',[u(13000)]));
 ok(call('v6-market','set-paused',[Cl.bool(true)],admin));
 const expectedSbtc=kind==='mixed'?500000n:kind==='stx-only'?0n:1000000n;
 const expectedStx=kind==='mixed'?1600000000n:kind==='stx-only'?3203212825n:0n;
 if(kind==='resting'){
  const cycleCV=read('v6-market','get-current-cycle');
  const deposit=read('v6-market','get-token-x-deposit',[cycleCV,cp(JV)]).value;
  const clock=cvToString(read(JV,'get-clock'));
  const poolTokens=ft(`${admin}.${J}`);
  ok(call('mock-ft','set-blocked-recipient',[Cl.some(cp(J))],admin));
  err(call(J,'emergency-recover',[],admin),402);
  assert.equal(read('v6-market','get-token-x-deposit',[cycleCV,cp(JV)]).value,deposit);
  assert.equal(cvToString(read(JV,'get-clock')),clock);
  assert.equal(ft(`${admin}.${J}`),poolTokens);
  assert.equal(read(J,'get-pending-swap').type,'some');
  assert.equal(cvToString(read(J,'is-recovered-tranche',[u(cycle),u(0)])),'false');
  ok(call('mock-ft','set-blocked-recipient',[Cl.none()],admin));
 }
 const recovered=ok(call(J,'emergency-recover',[],admin));
 assert.equal(recovered.value.sbtc.value,expectedSbtc);
 assert.equal(recovered.value.stx.value,expectedStx);
 assert.equal(cvToString(read(J,'get-pending-swap')),'none');
 assert.equal(cvToString(read(JV,'get-clock')).includes('(batch-start none)'),true);
 assert.equal(cvToString(read(JV,'is-empty')),'true');
 err(call(J,'finalize-swap'),115);
 err(call(J,'emergency-recover',[],admin),115);
 err(call(J,'withdraw-sbtc-fees',[u(1),Cl.principal(admin)],admin),111);
 if(expectedSbtc>0n)err(call(J,'sweep-recovered-sbtc-dust',[u(cycle),u(0)],admin),104);
 const beforeA=ft(alice),beforeB=ft(bob),stxA=stx(alice),stxB=stx(bob);
 // Recovered sBTC collection must not transfer any STX.
 ok(call(J,'pay-stx-stakers',[Cl.list([Cl.principal(alice)]),u(cycle),u(0)]));
 ok(call(J,'pay-recovered-sbtc-stakers',[Cl.list([Cl.principal(alice),Cl.principal(bob),Cl.principal(bob)]),u(cycle),u(0)]));
 assert.equal(stx(bob),stxB);
 ok(call(J,'pay-stx-stakers',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(cycle),u(0)]));
 const aGrossSbtc=expectedSbtc/4n,bGrossSbtc=expectedSbtc*3n/4n;
 const aGrossStx=expectedStx/4n,bGrossStx=expectedStx*3n/4n;
 assert.equal(ft(alice)-beforeA,aGrossSbtc);
 assert.equal(ft(bob)-beforeB,bGrossSbtc-bGrossSbtc/20n);
 assert.equal(stx(alice)-stxA,aGrossStx);
 assert.equal(stx(bob)-stxB,bGrossStx-bGrossStx/20n);
 const balances=[ft(alice),ft(bob),stx(alice),stx(bob)];
 ok(call(J,'pay-recovered-sbtc-stakers',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(cycle),u(0)]));
 ok(call(J,'pay-stx-stakers',[Cl.list([Cl.principal(bob)]),u(cycle),u(0)]));
 assert.deepEqual([ft(alice),ft(bob),stx(alice),stx(bob)],balances);
 const fees=read(J,'get-earned-sbtc-fees').value;
 err(call(J,'withdraw-sbtc-fees',[u(fees+1n),Cl.principal(admin)],admin),111);
 if(fees>0n)ok(call(J,'withdraw-sbtc-fees',[u(fees),Cl.principal(admin)],admin));
 ok(call('mock-dia','set-skew',[u(10000)]));
 ok(call('v6-market','set-paused',[Cl.bool(false)],admin));
 console.log(`Juice: ${kind} recovery at 432 blocks, paused withdrawals, mixed-asset payouts and replay passed`);
}
// Recovery dust and a subsequent normal batch coexist without mixing assets.
ok(call('mock-ft','mint',[u(7),cp(JV)]));
for(const [who,amount] of [[alice,1],[bob,3]])ok(call('mock-pox','stake-test',[cp(J),Cl.principal(who),u(164),u(amount)]));
ok(call(J,'pox-claim-rewards',[Cl.list([]),u(164)]));
sim.mineEmptyBurnBlocks(432);
ok(call(J,'emergency-recover',[],admin));
// Fund the next batch before the previous recovered batch is paid.
ok(call('mock-pox','next-dist'));
ok(call(J,'pox-claim-rewards',[Cl.list([]),u(164)]));
ok(call(J,'pay-recovered-sbtc-stakers',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(164),u(0)]));
assert.equal(ok(call(J,'sweep-recovered-sbtc-dust',[u(164),u(0)],admin)).value,1n);
err(call(J,'sweep-recovered-sbtc-dust',[u(164),u(0)],admin),105);
sim.mineEmptyBurnBlocks(288);
ok(call(JV,'router-swap',[update]));
assert.equal(ok(call(J,'finalize-swap')).value,3200000000n);
ok(call(J,'pay-stx-stakers',[Cl.list([Cl.principal(alice),Cl.principal(bob)]),u(164),u(1)]));
assert.equal(cvToString(read(JV,'is-empty')),'true');
console.log('Juice: recovered dust, unpaid recovery/next-batch isolation and return to normal STX route passed');

// Admin handover preserves the old admin until nominee accepts after 144 burns.
err(call(J,'accept-admin',[],bob),117);
err(call(J,'propose-admin',[Cl.principal(alice)],bob),100);
ok(call(J,'propose-admin',[Cl.principal(alice)],admin));
assert.equal(read(J,'get-admin').value,admin);
err(call(J,'accept-admin',[],alice),114);
err(call(J,'accept-admin',[],bob),100);
err(call(J,'set-paused',[Cl.bool(true)],alice),100);
ok(call(J,'set-paused',[Cl.bool(false)],admin));
sim.mineEmptyBurnBlocks(143);
err(call(J,'accept-admin',[],alice),114);
// Replacing a nominee resets the full delay, not just its remaining block.
ok(call(J,'propose-admin',[Cl.principal(bob)],admin));
sim.mineEmptyBurnBlock();
err(call(J,'accept-admin',[],alice),100);
err(call(J,'accept-admin',[],bob),114);
err(call(J,'cancel-admin-proposal',[],alice),100);
ok(call(J,'cancel-admin-proposal',[],admin));
err(call(J,'accept-admin',[],bob),117);
assert.equal(read(J,'get-admin').value,admin);
ok(call(J,'propose-admin',[Cl.principal(bob)],admin));
sim.mineEmptyBurnBlocks(143);
err(call(J,'accept-admin',[],bob),114);
sim.mineEmptyBurnBlock();
ok(call(J,'accept-admin',[],bob));
assert.equal(read(J,'get-admin').value,bob);
assert.equal(cvToString(read(J,'get-pending-admin')).includes('(admin none)'),true);
err(call(J,'accept-admin',[],bob),117);
err(call(J,'propose-admin',[Cl.principal(alice)],admin),100);
err(call(J,'set-paused',[Cl.bool(true)],admin),100);
ok(call(J,'set-paused',[Cl.bool(false)],bob));
// A later handover still works with its own fresh cooldown.
ok(call(J,'propose-admin',[Cl.principal(admin)],bob));
sim.mineEmptyBurnBlocks(144);
ok(call(J,'accept-admin',[],admin));
assert.equal(read(J,'get-admin').value,admin);
console.log('Juice: admin propose/accept at 144 burns, nominee-only acceptance, replacement/cancel, old-role revocation and repeat handover passed');

// FastPool vault rotation: fixed active vault, one-month notice, idle checks and old-vault revocation.
assert.equal(cvToString(read(F,'get-swap-vault')),cvToString(cp(FV)));
err(call(F,'propose-swap-vault',[cp(FV)],admin),1055);
err(call(F,'propose-swap-vault',[cp(FVN)],alice),1001);
ok(call(F,'propose-swap-vault',[cp(FVN)],admin));
err(call(F,'confirm-swap-vault',[cp(FV),cp(FVN)],admin),1057);
sim.mineEmptyBurnBlocks(4032);
ok(call(F,'confirm-swap-vault',[cp(FV),cp(FVN)],admin));
assert.equal(cvToString(read(F,'get-swap-vault')),cvToString(cp(FVN)));
err(call(F,'set-vault-window-blocks',[u(288)],admin),1055);
ok(sim.callPublicFn(F,'set-vault-window-blocks',[u(288),cp(FVN)],admin));
console.log('FastPool: trait-based vault rotation, 4032-block notice and active-vault enforcement passed');
