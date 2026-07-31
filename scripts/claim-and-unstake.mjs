#!/usr/bin/env node
//
// Autonomous driver: crystallize + claim signer/staker sBTC rewards for
// TARGET_CYCLES (a comma-separated list, e.g. "24,25,26,27") as each cycle
// completes on the live node, then unstake the staker once all cycles are
// claimed. Polls the node since cycles take real wall-clock time here.
//
// Env:
//   TARGET_CYCLES   default "24,25,26,27"
//   STAKER_INDEX    default 2
//   POLL_MS         default 45000
//   NETWORK / API_URL / CHAIN_ID / FEE / SIGNER_MANAGER  same as bootstrap.mjs
//
import {
  Cl, makeContractCall, broadcastTransaction, getAddressFromPrivateKey,
} from '@stacks/transactions';
import { STACKS_TESTNET } from '@stacks/network';
import { resolveDeployerKey, resolveKeyAtIndex } from './_wallet.mjs';
import { resolveNetwork, POX5_ADDR } from './_network.mjs';

const target = await resolveNetwork();
const API_URL = target.apiUrl;
const CHAIN_ID = BigInt(target.chainId);
const FEE = BigInt(process.env.FEE ?? '100000');
const POX5 = POX5_ADDR;
const POLL_MS = Number(process.env.POLL_MS ?? '45000');
const TARGET_CYCLES = (process.env.TARGET_CYCLES ?? '24,25,26,27').split(',').map((s) => parseInt(s.trim(), 10));
const client = { baseUrl: API_URL };
const net = { network: { ...STACKS_TESTNET, chainId: Number(CHAIN_ID) }, client };

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPoxInfo() {
  return fetch(`${API_URL}/v2/pox`).then((r) => r.json());
}

async function readUint(contractAddr, contractName, fn, argsHex = []) {
  const r = await fetch(`${API_URL}/v2/contracts/call-read/${contractAddr}/${contractName}/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: contractAddr, arguments: argsHex }),
  }).then((x) => x.json());
  if (!r.okay) throw new Error(`read-only ${fn} failed: ${JSON.stringify(r)}`);
  // r.result is a Clarity-serialized value: "0x" + 1-byte type-id (0x01 = uint) + 16-byte big-endian value.
  return BigInt(`0x${r.result.slice(4)}`);
}

function uintArgHex(n) {
  return `0x01${n.toString(16).padStart(32, '0')}`;
}

async function waitForTx(txid) {
  for (;;) {
    const r = await fetch(`${API_URL}/extended/v1/tx/${txid}`).then((x) => x.json());
    if (r.tx_status && r.tx_status !== 'pending') return r;
    await sleep(8000);
  }
}

async function broadcastAndWait(txOpts, label) {
  const tx = await makeContractCall({ fee: FEE, ...txOpts, ...net });
  const bc = await broadcastTransaction({ transaction: tx, ...net });
  if (bc.error) {
    log(`${label}: broadcast rejected -`, bc.reason ?? bc.error);
    return { ok: false, status: 'rejected', reason: bc.reason ?? bc.error };
  }
  log(`${label}: broadcast txid 0x${bc.txid}`);
  const r = await waitForTx(bc.txid);
  const ok = r.tx_status === 'success';
  log(`${label}: ${r.tx_status}${ok ? '' : ` (${JSON.stringify(r.tx_result?.repr ?? r.tx_result).slice(0, 160)})`}`);
  return { ok, status: r.tx_status, result: r };
}

async function maybeCalculateRewards(deployerKey) {
  const lastCalc = await readUint(POX5, 'pox-5', 'get-last-reward-compute-height');
  const distCycle = await readUint(POX5, 'pox-5', 'current-distribution-cycle');
  const distHeight = await readUint(POX5, 'pox-5', 'distribution-cycle-to-burn-height', [uintArgHex(distCycle)]);
  const calcHeight = distHeight - 1n;
  if (calcHeight <= lastCalc) {
    log(`calculate-rewards: nothing new (calc-height ${calcHeight} <= last-calc ${lastCalc})`);
    return;
  }
  await broadcastAndWait({
    contractAddress: POX5, contractName: 'pox-5', functionName: 'calculate-rewards',
    functionArgs: [Cl.list([])], senderKey: deployerKey, postConditionMode: 'allow',
  }, 'calculate-rewards');
}

async function main() {
  const deployerKey = await resolveDeployerKey();
  const deployerAddr = getAddressFromPrivateKey(deployerKey, 'testnet');
  const signerManager = process.env.SIGNER_MANAGER ?? `${deployerAddr}.fastpool-signer-manager`;
  const [smAddr, smName] = signerManager.split('.');
  const stakerKey = (process.env.STAKER_KEY ?? await resolveKeyAtIndex(Number(process.env.STAKER_INDEX ?? '2'))).replace(/^0x/, '');
  const stakerAddr = getAddressFromPrivateKey(stakerKey, 'testnet');

  log(`target cycles: ${TARGET_CYCLES.join(',')}; signer-manager ${signerManager}; staker ${stakerAddr}`);

  const claimed = new Set();
  while (claimed.size < TARGET_CYCLES.length) {
    const pox = await getPoxInfo();
    const currentCycle = pox.current_cycle.id;
    log(`burn ${pox.current_burnchain_block_height}, current_cycle ${currentCycle}, claimed ${[...claimed].join(',') || '-'}`);

    try {
      await maybeCalculateRewards(deployerKey);
    } catch (e) {
      log('calculate-rewards attempt errored:', String(e).slice(0, 200));
    }

    for (const cycle of TARGET_CYCLES) {
      if (claimed.has(cycle)) continue;
      if (currentCycle <= cycle) continue; // cycle not finished yet

      const cr = await broadcastAndWait({
        contractAddress: smAddr, contractName: smName, functionName: 'claim-rewards',
        functionArgs: [Cl.list([]), Cl.uint(BigInt(cycle))], senderKey: deployerKey, postConditionMode: 'allow',
      }, `claim-rewards(${cycle})`);
      if (!cr.ok) { log(`cycle ${cycle}: claim-rewards not ready yet, will retry`); continue; }

      const csr = await broadcastAndWait({
        contractAddress: smAddr, contractName: smName, functionName: 'claim-staker-rewards',
        functionArgs: [Cl.principal(stakerAddr), Cl.uint(BigInt(cycle)), Cl.none()],
        senderKey: deployerKey, postConditionMode: 'allow',
      }, `claim-staker-rewards(${cycle})`);
      if (csr.ok) {
        claimed.add(cycle);
        log(`cycle ${cycle} fully claimed (${claimed.size}/${TARGET_CYCLES.length})`);
      } else {
        log(`cycle ${cycle}: claim-staker-rewards failed, will retry`);
      }
    }

    if (claimed.size < TARGET_CYCLES.length) await sleep(POLL_MS);
  }

  log('all target cycles claimed; unstaking (retrying until out of prepare phase)');
  for (;;) {
    const res = await broadcastAndWait({
      contractAddress: POX5, contractName: 'pox-5', functionName: 'unstake',
      functionArgs: [Cl.contractPrincipal(smAddr, smName)], senderKey: stakerKey, postConditionMode: 'allow',
    }, 'unstake');
    if (res.ok) break;
    log('unstake not accepted yet (likely prepare phase) — retrying');
    await sleep(POLL_MS);
  }
  log('DONE: rewards claimed for cycles', TARGET_CYCLES.join(','), 'and staker unstaked');
}

main().catch((e) => { log('FATAL', e); process.exit(1); });
