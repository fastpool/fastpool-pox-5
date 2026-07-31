#!/usr/bin/env node
//
// Deploy this project's contracts to a pox-5 chain. The default target is the
// private Hiro node, which uses a CUSTOM Stacks chain id (256). Clarinet
// hard-codes testnet = 2147483648 and exposes no chain-id override, so we sign +
// broadcast with @stacks/transactions instead. The chain id is read from the
// node's /v2/info rather than assumed, so pointing at a different node is safe.
//
// Target selection (see scripts/_network.mjs):
//   NETWORK=private-1  (default) the private node running stacks-node 4.x
//   NETWORK=testnet    the public Hiro testnet -- currently REJECTED by the
//                      preflight below: it runs pox-4, there is no pox-5 there.
//
// The contracts reference MAINNET principals so the simnet tests can resolve them
// (canonical boot pox-5 at SP000…, mainnet sBTC at SM3VDXK3…). On the node those
// live at DIFFERENT addresses, so at deploy time we rewrite the source:
//   - boot pox-5   SP000000000000000000002Q6VF78 -> ST000000000000000000002AMW42H
//   - sBTC suite   SM3VDXK3…                      -> the target chain's sBTC
//     Both already exist on the node, so they are REMAPPED only (never published).
// Any requirement the node LACKS (e.g. a SIP-010 trait) would instead be
// republished under the deployer and its principal remapped to the deployer, as
// `clarinet deployments apply` would; source comes from .cache/requirements/<id>.
//
// Publishes, under the deployer and in order: the republished requirements (none
// here — sBTC is remapped, not published), then [contracts.*]. Idempotent:
// contracts already on the node are skipped (handy across the node's daily resets).
//
// Deployer key resolved from DEPLOYER_KEY (hex), DEPLOYER_MNEMONIC, or the
// mnemonic in settings/Testnet.toml (see scripts/_wallet.mjs).
//
// Env:
//   DEPLOYER_KEY / DEPLOYER_MNEMONIC   override the Testnet.toml mnemonic
//   NETWORK        profile name; default private-1
//   API_URL        overrides the profile's node URL
//   CHAIN_ID       overrides the chain id auto-detected from /v2/info
//   SBTC_ADDR      overrides the profile's sBTC deployer address
//   FEE            fixed fee (uSTX) per publish; default 1000000 (1 STX)
//   MANIFEST       default ./Clarinet.toml
//   MIN_USTX       faucet floor; default 50000000 (skip funding if >=)
//   SKIP_PREFLIGHT set to 1 to downgrade the pox-5/sBTC check to a warning
//
// Usage:  ./scripts/deploy-testnet.sh   (mnemonic from settings/Testnet.toml)
//
import { readFileSync } from 'node:fs';
import {
  makeContractDeploy, broadcastTransaction, getAddressFromPrivateKey,
} from '@stacks/transactions';
import { STACKS_TESTNET } from '@stacks/network';
import { resolveDeployerKey } from './_wallet.mjs';
import { resolveNetwork, assertDeployable, MAINNET_POX5, MAINNET_SBTC, POX5_ADDR } from './_network.mjs';

const MANIFEST = process.env.MANIFEST ?? './Clarinet.toml';
const MIN_USTX = BigInt(process.env.MIN_USTX ?? '50000000');
const FEE = BigInt(process.env.FEE ?? '1000000'); // 1 STX/publish; override with FEE
const key = await resolveDeployerKey();

const net = await resolveNetwork();
const { apiUrl: API_URL, chainId: CHAIN_ID } = net;

// Custom chainId for signing; transactionVersion stays testnet (ST/SN addresses).
const network = { ...STACKS_TESTNET, chainId: CHAIN_ID };
const client = { baseUrl: API_URL };
const deployer = getAddressFromPrivateKey(key, 'testnet');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const contractExists = (name) =>
  fetch(`${API_URL}/v2/contracts/interface/${deployer}/${name}`).then((r) => r.ok).catch(() => false);

async function accountState() {
  const r = await fetch(`${API_URL}/v2/accounts/${deployer}?proof=0`).then((x) => x.json());
  return { nonce: Number(r.nonce), balance: BigInt(parseInt(r.balance, 16)) };
}

const toml = readFileSync(MANIFEST, 'utf8');

// contract_id list (mainnet contracts) from either requirements style:
// the inline `requirements = [{contract_id = '…'}]` array or [[project.requirements]].
// Both quote styles are valid TOML, so accept either.
function parseRequirements() {
  return [...toml.matchAll(/contract_id\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
}

// ordered [contracts.NAME] { path, clarity_version } from the manifest
function parseContracts() {
  const out = [];
  const re = /\[contracts\.([A-Za-z0-9_-]+)\]([\s\S]*?)(?=\n\[|\s*$)/g;
  let m;
  while ((m = re.exec(toml))) {
    const path = (m[2].match(/path\s*=\s*"([^"]+)"/) || [])[1];
    const cv = Number((m[2].match(/clarity_version\s*=\s*(\d+)/) || [])[1] || 5);
    if (path) out.push({ name: m[1], path, clarityVersion: cv });
  }
  return out;
}

// Mainnet principals the contracts reference (for simnet/tests) that already
// exist on the node under a DIFFERENT address: remapped in source, never
// republished. (boot pox-5 mainnet->testnet; mainnet sBTC -> the node's sBTC.)
const NODE_REMAP = {
  [MAINNET_POX5]: POX5_ADDR,
  [MAINNET_SBTC]: net.sbtc,
};

// Build the ordered publish list: republished requirements first (only those the
// node lacks), then local contracts. All sources are rewritten: NODE_REMAP
// principals point at their on-node address, and any republished requirement's
// principal points at the deployer.
function buildUnits() {
  const remap = { ...NODE_REMAP }; // principal -> on-node (or deployer) address
  const reqUnits = [];
  for (const id of parseRequirements()) {
    const [principal, name] = id.split('.');
    // sBTC & co. already live on the node (via NODE_REMAP) — remap only, skip.
    if (NODE_REMAP[principal]) continue;
    remap[principal] = deployer;
    const meta = JSON.parse(readFileSync(`.cache/requirements/${id}.json`, 'utf8'));
    reqUnits.push({
      name,
      source: readFileSync(`.cache/requirements/${id}.clar`, 'utf8'),
      clarityVersion: Number(String(meta.clarity_version).replace(/\D/g, '')) || 1,
    });
  }
  const applyRemap = (src) =>
    Object.entries(remap).reduce((s, [from, to]) => s.split(from).join(to), src);
  const localUnits = parseContracts().map((c) => ({
    name: c.name,
    source: applyRemap(readFileSync(c.path, 'utf8')),
    clarityVersion: c.clarityVersion,
  }));
  reqUnits.forEach((u) => { u.source = applyRemap(u.source); });
  return [...reqUnits, ...localUnits];
}

async function fund() {
  let { balance } = await accountState();
  for (let i = 0; balance < MIN_USTX && i < 8; i++) {
    console.log(`  faucet (${balance} < ${MIN_USTX}) ...`);
    await fetch(`${API_URL}/extended/v1/faucets/stx?address=${deployer}`, { method: 'POST' }).catch(() => {});
    await sleep(12000);
    ({ balance } = await accountState());
  }
  if (balance < MIN_USTX) { console.error('deployer underfunded after faucet'); process.exit(1); }
}

async function waitFor(name) {
  for (let i = 0; i < 60; i++) { if (await contractExists(name)) return true; await sleep(5000); }
  return false;
}

const units = buildUnits();
console.log(`network ${net.name} | deployer ${deployer} | chain ${CHAIN_ID} | node ${API_URL}`);
console.log(`sBTC ${net.sbtc}`);
// Fail before spending a faucet call / broadcasting: publishing against a chain
// without pox-5 aborts in analysis with a far less obvious error.
await assertDeployable(net, { warnOnly: process.env.SKIP_PREFLIGHT === '1' });
console.log(`publishing: ${units.map((u) => u.name).join(', ')}`);
await fund();

let { nonce } = await accountState();
for (const u of units) {
  if (await contractExists(u.name)) { console.log(`= ${u.name} exists, skip`); continue; }
  const tx = await makeContractDeploy({
    contractName: u.name,
    codeBody: u.source,
    clarityVersion: u.clarityVersion,
    senderKey: key,
    network, client, nonce, fee: FEE,
    postConditionMode: 'allow',
  });
  const res = await broadcastTransaction({ transaction: tx, network, client });
  if (res.error) { console.error(`x ${u.name}:`, JSON.stringify(res)); process.exit(1); }
  console.log(`-> ${u.name} clarity${u.clarityVersion} nonce ${nonce} txid 0x${res.txid}`);
  nonce++;
  if (!(await waitFor(u.name))) { console.error(`x ${u.name} not confirmed in time`); process.exit(1); }
  console.log(`   ok ${u.name}`);
}
console.log('deploy complete.');
