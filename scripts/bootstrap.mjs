#!/usr/bin/env node
//
// Bootstrap the STX-only pool on the private Hiro testnet AFTER signer-manager
// is deployed (see deploy-testnet.sh).
//
//   node scripts/bootstrap.mjs register             # register the signer with pox-5
//   node scripts/bootstrap.mjs fund-staker           # stacking faucet -> the staker account
//   node scripts/bootstrap.mjs stake                 # smoke-test: stake STX through it
//   node scripts/bootstrap.mjs extend                # stake-update (+1 cycle)
//   node scripts/bootstrap.mjs unstake               # stop stacking (unlocks next cycle)
//   AMOUNT_USTX=<n> node scripts/bootstrap.mjs transfer   # send STX acct 2 -> acct 3 (other staker)
//   node scripts/bootstrap.mjs staker-info           # read-only: STX + pox-5 staker-info for accts 2,3,4
//   FEES_BIPS=450 node scripts/bootstrap.mjs set-fees  # set signer-manager fee (450 bips = 4.5%)
//   REWARD_CYCLE=29 node scripts/bootstrap.mjs claim-rewards          # signer pulls its sBTC for the cycle
//   REWARD_CYCLE=29 STAKER_INDEX=2 \
//     node scripts/bootstrap.mjs claim-staker-rewards                  # pay a staker their share
//
// pox-5  = ST000000000000000000002AMW42H.pox-5   (boot contract on the node)
// sBTC   = SN3R84XZYA63QS28932XQF3G1J8R9PC3W76P9CSQS.sbtc-*
//
// register-self(signer-manager, signer-key, auth-id, signer-sig):
//   signer-sig is a SIP-018 signature over
//     domain  = { name: "pox-5-signer", version: "1.0.0", chain-id }
//     message = { topic: "grant-authorization", signer-manager, auth-id }
//   produced by the SIGNER key (not the deployer key). signStructuredData does
//   the full SIP-018 hashing for us.
//
// Keys come from the mnemonic in settings/Testnet.toml (or DEPLOYER_MNEMONIC):
// deployer = account 0, signer = account 1. Override with the *_KEY hex envs.
//
// Env:
//   NETWORK           profile name; default private-1 (see scripts/_network.mjs)
//   API_URL           overrides the profile's node URL
//   CHAIN_ID          overrides the chain id auto-detected from /v2/info.
//                     Also the SIP-018 domain chain-id for the signer grant.
//   FEE               default 100000 uSTX per call
//   DEPLOYER_KEY      hex override for the deployer (else mnemonic account 0)
//   SIGNER_KEY        hex override for the pox signer (else mnemonic account 1)
//   SIGNER_INDEX      mnemonic account index for the signer (default 1)
//   AUTH_ID           default 1   (unique per grant; bump on re-register)
//   SIGNER_MANAGER    default <deployerAddr>.fastpool-signer-manager
//   For `stake`:
//   STAKER_KEY        staker's private key (defaults to the deployer key)
//   AMOUNT_USTX       default 100000000000  (100k STX)
//   NUM_CYCLES        default 1
//   START_BURN_HT     default: next cycle start (read from the node)
//
import {
  Cl, signStructuredData, privateKeyToPublic, getAddressFromPrivateKey,
  makeContractCall, makeSTXTokenTransfer, broadcastTransaction,
  serializeCV, deserializeCV, cvToValue,
} from '@stacks/transactions';
import { STACKS_TESTNET } from '@stacks/network';
import { resolveDeployerKey, resolveKeyAtIndex } from './_wallet.mjs';
import { resolveNetwork, POX5_ADDR } from './_network.mjs';

const target = await resolveNetwork();
const API_URL = target.apiUrl;
// The private node uses a custom chain id (256); public testnet uses
// 2147483648. It is used BOTH for signing the tx AND inside pox-5's SIP-018
// `grant-authorization` domain (`chain-id`), so the signer-grant signature must
// be computed with the same value or it is rejected. Detected from the node.
const CHAIN_ID = BigInt(target.chainId);
const FEE = BigInt(process.env.FEE ?? '100000'); // 0.1 STX/call; override with FEE
const POX5 = POX5_ADDR;
const client = { baseUrl: API_URL };
// chainId from the node; transactionVersion stays testnet (ST/SN addresses).
const net = { network: { ...STACKS_TESTNET, chainId: Number(CHAIN_ID) }, client };

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`missing env ${k}`); process.exit(1); } return v.replace(/^0x/, ''); };
const hex = (b) => (b.startsWith('0x') ? b.slice(2) : b);

async function send(txOpts, label) {
  const tx = await makeContractCall({ fee: FEE, ...txOpts, ...net });
  const res = await broadcastTransaction({ transaction: tx, ...net });
  if (res.error) { console.error(`${label} FAILED:`, JSON.stringify(res)); process.exit(1); }
  console.log(`${label} broadcast: txid 0x${res.txid}`);
  console.log(`  ${API_URL.replace('api.', 'explorer.')}/txid/0x${res.txid}`);
  return res.txid;
}

async function register() {
  const deployerKey = await resolveDeployerKey();
  // Signer key = mnemonic account index 1 (the account after the deployer),
  // unless SIGNER_KEY (hex) is set. Override the index with SIGNER_INDEX.
  const signerKey = await resolveKeyAtIndex(Number(process.env.SIGNER_INDEX ?? '1'), process.env.SIGNER_KEY);
  const authId = BigInt(process.env.AUTH_ID ?? '1');
  const deployerAddr = getAddressFromPrivateKey(deployerKey, 'testnet');
  const signerManager = process.env.SIGNER_MANAGER ?? `${deployerAddr}.fastpool-signer-manager`;
  const [smAddr, smName] = signerManager.split('.');
  const signerPubKey = privateKeyToPublic(signerKey); // 33-byte compressed hex

  const domain = Cl.tuple({
    name: Cl.stringAscii('pox-5-signer'),
    version: Cl.stringAscii('1.0.0'),
    'chain-id': Cl.uint(CHAIN_ID),
  });
  const message = Cl.tuple({
    topic: Cl.stringAscii('grant-authorization'),
    'signer-manager': Cl.principal(signerManager),
    'auth-id': Cl.uint(authId),
  });
  const signerSig = hex(signStructuredData({ message, domain, privateKey: signerKey }));

  console.log(`register: signer-manager=${signerManager} signer-key=0x${hex(signerPubKey)} auth-id=${authId}`);
  await send({
    contractAddress: smAddr,
    contractName: smName,
    functionName: 'register-self',
    functionArgs: [
      Cl.contractPrincipal(smAddr, smName),
      Cl.bufferFromHex(hex(signerPubKey)),
      Cl.uint(authId),
      Cl.bufferFromHex(signerSig),
    ],
    senderKey: deployerKey,
    postConditionMode: 'allow',
  }, 'register-self');
}

// Fund the staker (STAKER_KEY, else mnemonic account STAKER_INDEX, default 2)
// via the stacking faucet, which gives the 50k STX stacking minimum in one
// call (the default STX faucet only gives 500/call). Per-IP rate-limited --
// run from your own IP if it returns "Too many requests".
async function fundStaker() {
  const stakerKey = (process.env.STAKER_KEY ?? await resolveKeyAtIndex(Number(process.env.STAKER_INDEX ?? '2'))).replace(/^0x/, '');
  const staker = getAddressFromPrivateKey(stakerKey, 'testnet');
  const r = await fetch(`${API_URL}/extended/v1/faucets/stx?address=${staker}&stacking=true`, { method: 'POST' }).then((x) => x.json());
  console.log(`stacking faucet -> ${staker} (acct ${process.env.STAKER_INDEX ?? '2'}):`, JSON.stringify(r));
}

async function nextCycleStart() {
  const r = await fetch(`${API_URL}/v2/pox`).then((x) => x.json());
  return BigInt(r.next_cycle.prepare_phase_start_block_height ?? r.next_cycle.reward_phase_start_block_height);
}

async function stake() {
  const deployerKey = await resolveDeployerKey();
  const stakerKey = (process.env.STAKER_KEY ?? await resolveKeyAtIndex(Number(process.env.STAKER_INDEX ?? '2'))).replace(/^0x/, '');
  const deployerAddr = getAddressFromPrivateKey(deployerKey, 'testnet');
  const signerManager = process.env.SIGNER_MANAGER ?? `${deployerAddr}.fastpool-signer-manager`;
  const [smAddr, smName] = signerManager.split('.');
  const amount = BigInt(process.env.AMOUNT_USTX ?? '100000000000');
  const cycles = BigInt(process.env.NUM_CYCLES ?? '1');
  const startBurnHt = process.env.START_BURN_HT ? BigInt(process.env.START_BURN_HT) : await nextCycleStart();
  
  console.log(`stake: ${amount} uSTX for ${cycles} cycle(s) starting burn ht ${startBurnHt} via ${signerManager} for ${getAddressFromPrivateKey(stakerKey, 'testnet')}`);
  await send({
    contractAddress: POX5,
    contractName: 'pox-5',
    functionName: 'stake',
    functionArgs: [
      Cl.contractPrincipal(smAddr, smName),
      Cl.uint(amount),
      Cl.uint(cycles),
      Cl.uint(startBurnHt),
      Cl.none(), // signer-calldata: none unless this signer-manager requires it
    ],
    senderKey: stakerKey,
    postConditionMode: 'allow',
  }, 'stake');
}

// Extend the staker's lock by EXTEND_CYCLES (default 1) via pox-5.stake-update.
async function extend() {
  const stakerKey = (process.env.STAKER_KEY ?? await resolveKeyAtIndex(2)).replace(/^0x/, '');
  const deployerAddr = getAddressFromPrivateKey(await resolveDeployerKey(), 'testnet');
  const signerManager = process.env.SIGNER_MANAGER ?? `${deployerAddr}.fastpool-signer-manager`;
  const [smAddr, smName] = signerManager.split('.');
  const cycles = BigInt(process.env.EXTEND_CYCLES ?? '1');
  console.log(`stake-update: +${cycles} cycle(s) via ${signerManager}`);
  await send({
    contractAddress: POX5, contractName: 'pox-5', functionName: 'stake-update',
    functionArgs: [
      Cl.contractPrincipal(smAddr, smName), // new signer-manager
      Cl.contractPrincipal(smAddr, smName), // old (unchanged)
      Cl.uint(cycles), Cl.uint(1000000), Cl.none(),
    ],
    senderKey: stakerKey, postConditionMode: 'allow',
  }, 'stake-update');
}

// pox-5 has no native auto-extend, so this loop calls stake-update (+1 cycle)
// whenever the lock is about to lapse (within the prepare phase), rolling the
// stake over cycle-to-cycle until the lock is gone (e.g. the node's daily reset)
// or the process is stopped.
async function autoExtend() {
  const stakerKey = (process.env.STAKER_KEY ?? await resolveKeyAtIndex(2)).replace(/^0x/, '');
  const staker = getAddressFromPrivateKey(stakerKey, 'testnet');
  const pox0 = await fetch(`${API_URL}/v2/pox`).then((r) => r.json());
  const prepare = Number(pox0.prepare_phase_block_length ?? 5);
  const POLL_MS = Number(process.env.POLL_MS ?? '60000');
  console.log(`auto-extend: staker ${staker}; extend within ${prepare + 2} blocks of unlock; poll ${POLL_MS}ms`);
  for (;;) {
    const acct = await fetch(`${API_URL}/v2/accounts/${staker}?proof=0`).then((r) => r.json());
    const unlock = Number(acct.unlock_height);
    const burn = Number((await fetch(`${API_URL}/v2/pox`).then((r) => r.json())).current_burnchain_block_height);
    if (BigInt(acct.locked) === 0n) { console.log('no active lock (unlocked or node reset) — stopping'); break; }
    if (unlock - burn <= prepare + 2) {
      console.log(`extend: burn ${burn}, unlock ${unlock} (${unlock - burn} left)`);
      try { await extend(); } catch (e) { console.error('extend failed:', String(e).slice(0, 140)); }
    } else {
      console.log(`hold: burn ${burn}, unlock ${unlock} (${unlock - burn} blocks left)`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// Pull the signer's sBTC reward for REWARD_CYCLE into the signer-manager
// (signer-manager.claim-rewards). Permissionless; signed by the deployer.
// BOND_PERIODS is a comma-separated list of bond indices (empty for STX-only).
async function claimRewards() {
  const deployerKey = await resolveDeployerKey();
  const deployerAddr = getAddressFromPrivateKey(deployerKey, 'testnet');
  const signerManager = process.env.SIGNER_MANAGER ?? `${deployerAddr}.fastpool-signer-manager`;
  const [smAddr, smName] = signerManager.split('.');
  const cycle = BigInt(need('REWARD_CYCLE'));
  const bondPeriods = (process.env.BOND_PERIODS ?? '').split(',').filter(Boolean).map((n) => Cl.uint(BigInt(n)));
  console.log(`claim-rewards: cycle ${cycle} via ${signerManager} (${bondPeriods.length} bond-period(s))`);
  await send({
    contractAddress: smAddr, contractName: smName, functionName: 'claim-rewards',
    functionArgs: [Cl.list(bondPeriods), Cl.uint(cycle)],
    senderKey: deployerKey, postConditionMode: 'allow',
  }, `claim-rewards(${cycle})`);
}

// Pay a staker their sBTC share for REWARD_CYCLE out of the signer-manager
// (signer-manager.claim-staker-rewards). Permissionless; signed by the deployer.
// Staker = STAKER_ADDR, else mnemonic account STAKER_INDEX (default 2).
// BOND_INDEX optional (none for STX-only).
async function claimStakerRewards() {
  const deployerKey = await resolveDeployerKey();
  const deployerAddr = getAddressFromPrivateKey(deployerKey, 'testnet');
  const signerManager = process.env.SIGNER_MANAGER ?? `${deployerAddr}.fastpool-signer-manager`;
  const [smAddr, smName] = signerManager.split('.');
  const cycle = BigInt(need('REWARD_CYCLE'));
  const staker = process.env.STAKER_ADDR
    ?? getAddressFromPrivateKey(await resolveKeyAtIndex(Number(process.env.STAKER_INDEX ?? '2')), 'testnet');
  const bondIndex = process.env.BOND_INDEX ? Cl.some(Cl.uint(BigInt(process.env.BOND_INDEX))) : Cl.none();
  console.log(`claim-staker-rewards: staker ${staker} cycle ${cycle}`);
  await send({
    contractAddress: smAddr, contractName: smName, functionName: 'claim-staker-rewards',
    functionArgs: [Cl.principal(staker), Cl.uint(cycle), bondIndex],
    senderKey: deployerKey, postConditionMode: 'allow',
  }, `claim-staker-rewards(${staker},${cycle})`);
}

// Stop stacking: pox-5.unstake(signer-manager). The staker's STX unlocks at the
// start of the next cycle. Rejected during the prepare phase. Signed by the
// staker (STAKER_KEY, else mnemonic account STAKER_INDEX, default 2).
async function unstake() {
  const stakerKey = (process.env.STAKER_KEY ?? await resolveKeyAtIndex(Number(process.env.STAKER_INDEX ?? '2'))).replace(/^0x/, '');
  const deployerAddr = getAddressFromPrivateKey(await resolveDeployerKey(), 'testnet');
  const signerManager = process.env.SIGNER_MANAGER ?? `${deployerAddr}.fastpool-signer-manager`;
  const [smAddr, smName] = signerManager.split('.');
  console.log(`unstake: ${getAddressFromPrivateKey(stakerKey, 'testnet')} via ${signerManager}`);
  await send({
    contractAddress: POX5, contractName: 'pox-5', functionName: 'unstake',
    functionArgs: [Cl.contractPrincipal(smAddr, smName)], // old-signer-manager (current signer)
    senderKey: stakerKey, postConditionMode: 'allow',
  }, 'unstake');
}

// Send AMOUNT_USTX of STX to another staker. From = FROM_KEY, else mnemonic
// account FROM_INDEX (default 2, the staker). To = TO address, else mnemonic
// account TO_INDEX (default 3, the other staker).
async function transfer() {
  const fromKey = (process.env.FROM_KEY ?? await resolveKeyAtIndex(Number(process.env.FROM_INDEX ?? '2'))).replace(/^0x/, '');
  const from = getAddressFromPrivateKey(fromKey, 'testnet');
  const to = process.env.TO ?? getAddressFromPrivateKey(await resolveKeyAtIndex(Number(process.env.TO_INDEX ?? '3')), 'testnet');
  const amount = BigInt(need('AMOUNT_USTX'));
  const nonce = Number((await fetch(`${API_URL}/v2/accounts/${from}?proof=0`).then((r) => r.json())).nonce);
  const tx = await makeSTXTokenTransfer({
    recipient: to, amount, senderKey: fromKey, nonce, fee: FEE, memo: 'fastpool transfer', ...net,
  });
  const res = await broadcastTransaction({ transaction: tx, ...net });
  if (res.error) { console.error('transfer FAILED:', JSON.stringify(res)); process.exit(1); }
  console.log(`transfer ${amount} uSTX: ${from} -> ${to}`);
  console.log(`  txid 0x${res.txid}`);
}

// Read-only `call-read` against pox-5. Returns the decoded result (cvToValue with
// strictJsonCompat: uints are strings, `(none)` decodes to null). Signs nothing.
async function callRead(fn, argCVs) {
  const body = JSON.stringify({ sender: POX5, arguments: argCVs.map((cv) => `0x${serializeCV(cv)}`) });
  const r = await fetch(`${API_URL}/v2/contracts/call-read/${POX5}/pox-5/${fn}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  }).then((x) => x.json());
  if (!r.okay) throw new Error(`call-read ${fn}: ${JSON.stringify(r)}`);
  return cvToValue(deserializeCV(r.result), true); // null when the result is (none)
}

// Set the signer-manager fee rate (admin = deployer). FEES_BIPS is basis points
// (450 = 4.5%, the usual rate); max 10000. signer-manager = <deployer>.fastpool-signer-manager
// unless SIGNER_MANAGER is set. Fees apply to future reward claims.
async function setFees() {
  const deployerKey = await resolveDeployerKey();
  const deployerAddr = getAddressFromPrivateKey(deployerKey, 'testnet');
  const signerManager = process.env.SIGNER_MANAGER ?? `${deployerAddr}.fastpool-signer-manager`;
  const [smAddr, smName] = signerManager.split('.');
  const bips = BigInt(process.env.FEES_BIPS ?? '450');
  console.log(`update-fees: ${bips} bips (${Number(bips) / 100}%) on ${signerManager}`);
  await send({
    contractAddress: smAddr,
    contractName: smName,
    functionName: 'update-fees',
    functionArgs: [Cl.uint(bips)],
    senderKey: deployerKey,
    postConditionMode: 'allow',
  }, 'update-fees');
}

// Read-only: STX account state + pox-5 STX-only staker-info for mnemonic accounts
// 2, 3, 4 (the stakers; override the set with STAKER_INDICES="2,3,4"). Signs
// nothing. `get-staker-info` returns none when the account has no active stake.
async function stakerInfo() {
  const indices = (process.env.STAKER_INDICES ?? '2,3,4').split(',').map((n) => Number(n.trim()));
  const stx = (u) => `${u} uSTX (${Number(u) / 1e6} STX)`;
  for (const i of indices) {
    const addr = getAddressFromPrivateKey(await resolveKeyAtIndex(i), 'testnet');
    const acct = await fetch(`${API_URL}/v2/accounts/${addr}?proof=0`).then((r) => r.json());
    const info = await callRead('get-staker-info', [Cl.principal(addr)]);
    console.log(`account #${i}  ${addr}`);
    console.log(`  balance ${stx(BigInt(acct.balance))} | locked ${stx(BigInt(acct.locked))}`
      + ` | unlock-burn-ht ${acct.unlock_height} | nonce ${acct.nonce}`);
    if (info === null) {
      console.log('  staker-info: none (no active STX-only stake)');
    } else {
      const f = info.value;
      console.log(`  staker-info: signer ${f.signer.value} | amount ${stx(f['amount-ustx'].value)}`
        + ` | first-reward-cycle ${f['first-reward-cycle'].value} | num-cycles ${f['num-cycles'].value}`);
    }
  }
}

const cmd = process.argv[2];
const cmds = {
  register, 'fund-staker': fundStaker, stake, extend, unstake, transfer, 'auto-extend': autoExtend,
  'claim-rewards': claimRewards, 'claim-staker-rewards': claimStakerRewards,
  'staker-info': stakerInfo, 'set-fees': setFees,
};
if (cmds[cmd]) await cmds[cmd]();
else { console.error(`usage: node scripts/bootstrap.mjs <${Object.keys(cmds).join('|')}>`); process.exit(1); }
