// Network profiles for the deploy/bootstrap scripts.
//
// Select one with NETWORK=<name>; individual env vars (API_URL, CHAIN_ID,
// SBTC_ADDR) still override whatever the profile says.
//
//   NETWORK=private-1   (default) the private Hiro node running stacks-node 4.x
//                       with pox-5. Custom chain id 256.
//   NETWORK=testnet     the public Hiro testnet, api.testnet.hiro.so.
//
// !! The public testnet CANNOT run these contracts today -- see preflight()
// below and the README. It is wired up here so that the moment testnet ships
// pox-5, `NETWORK=testnet ./scripts/deploy-testnet.sh` just works.
//
// pox-5 lives at the boot address on every testnet-style chain, so it is not
// per-profile. The sBTC suite is: each chain has its own deployment.

export const POX5_ADDR = 'ST000000000000000000002AMW42H';

// Mainnet principals the contracts reference so simnet can resolve them. These
// are rewritten at publish time to their address on the target chain.
export const MAINNET_POX5 = 'SP000000000000000000002Q6VF78';
export const MAINNET_SBTC = 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4';

export const PROFILES = {
  'private-1': {
    apiUrl: 'https://api.private-1.hiro.so',
    // sBTC as deployed on the private node.
    sbtc: 'SN3R84XZYA63QS28932XQF3G1J8R9PC3W76P9CSQS',
  },
  testnet: {
    apiUrl: 'https://api.testnet.hiro.so',
    // sBTC as deployed on the public testnet. NOTE: this deployment has
    // sbtc-token / sbtc-registry / sbtc-deposit but NOT sbtc-withdrawal, which
    // both signer managers need for the L1 pox-addr payout path.
    sbtc: 'ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT',
  },
};

// Contracts that must exist on the target chain before either signer manager
// can be published. Missing any of them is an analysis error at publish time
// with a much less obvious message than the one preflight() prints.
const REQUIRED = [
  [POX5_ADDR, 'pox-5', 'the pox-5 boot contract (signer-manager-trait lives here)'],
  ['sbtc', 'sbtc-token', 'sBTC token'],
  ['sbtc', 'sbtc-registry', 'sBTC registry (withdrawal request lookups)'],
  ['sbtc', 'sbtc-withdrawal', 'sBTC withdrawal (L1 pox-addr payout path)'],
];

const contractExists = (apiUrl, principal, name) =>
  fetch(`${apiUrl}/v2/contracts/interface/${principal}/${name}`)
    .then((r) => r.ok)
    .catch(() => false);

// Resolve the target network. chainId is read from the node itself unless
// CHAIN_ID is set -- the private node reports 256 and the public testnet
// 2147483648, and getting it wrong fails with an opaque SignatureValidation
// "invalid chain ID" only after the tx has been broadcast.
export async function resolveNetwork() {
  const name = process.env.NETWORK ?? 'private-1';
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error(
      `unknown NETWORK "${name}"; expected one of: ${Object.keys(PROFILES).join(', ')}`,
    );
  }
  const apiUrl = process.env.API_URL ?? profile.apiUrl;
  const sbtc = process.env.SBTC_ADDR ?? profile.sbtc;

  let chainId = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID) : null;
  if (chainId === null) {
    const info = await fetch(`${apiUrl}/v2/info`).then((r) => r.json()).catch(() => null);
    if (!info?.network_id) {
      throw new Error(`cannot reach ${apiUrl}/v2/info to detect the chain id; set CHAIN_ID`);
    }
    chainId = Number(info.network_id);
  }
  return { name, apiUrl, chainId, sbtc };
}

// Verify the target chain actually has what the contracts import. Returns the
// list of missing contracts (empty = good).
export async function preflight({ apiUrl, sbtc }) {
  const missing = [];
  for (const [principal, contract, why] of REQUIRED) {
    const addr = principal === 'sbtc' ? sbtc : principal;
    if (!(await contractExists(apiUrl, addr, contract))) {
      missing.push({ id: `${addr}.${contract}`, why });
    }
  }
  return missing;
}

// Print the preflight result; exit non-zero when the chain cannot host the
// contracts. Pass { warnOnly: true } to report without exiting.
export async function assertDeployable(net, { warnOnly = false } = {}) {
  const missing = await preflight(net);
  if (missing.length === 0) {
    console.log(`preflight ok: ${net.name} (chain ${net.chainId}) has pox-5 + the sBTC suite`);
    return true;
  }
  console.error(`\npreflight FAILED on ${net.name} (${net.apiUrl}, chain ${net.chainId}):`);
  for (const m of missing) console.error(`  x missing ${m.id}\n      -- ${m.why}`);
  if (net.name === 'testnet') {
    console.error(
      '\n  The public Hiro testnet runs stacks-node 3.4.x, whose PoX contract is\n'
      + '  pox-4. There is no pox-5 there yet, so a contract that does\n'
      + '  (impl-trait \'ST000000000000000000002AMW42H.pox-5.signer-manager-trait)\n'
      + '  cannot pass analysis at publish time.\n'
      + '  Use NETWORK=private-1 (the default) until testnet ships pox-5.',
    );
  }
  if (!warnOnly) process.exit(1);
  return false;
}
