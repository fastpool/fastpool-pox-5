#!/usr/bin/env node
//
// Build a Clarinet deployment plan that REPLAYS an on-chain contract call.
//
// Point it at a txid; it reads the transaction from a Stacks API, decodes the
// call, and writes deployments/replay-<txid8>.<network>-plan.yaml containing the
// same contract-id / method / arguments, ready for `clarinet deployments apply`.
// The arguments are the API's Clarity `repr` of the on-chain hex, so the replay
// is argument-for-argument identical to the original transaction.
//
// Typical use: a payout batch that aborted (fee too low, balance too low, a
// post-condition) and has to be re-sent verbatim once the cause is fixed.
//
// What a replay canNOT carry over -- all of it is recorded in the plan header:
//   - sponsorship. Clarinet signs and pays with the sender's own key, so a
//     sponsored transaction becomes self-paid (see FEE below).
//   - post-conditions. Clarinet broadcasts contract calls in post-condition mode
//     `allow`; the original conditions are written into the header as comments
//     only. Re-read them before applying.
//   - the nonce. The original nonce is spent; Clarinet takes the next one.
//
// If the sender had `sent_equal_to` / `sent_greater_than` STX post-conditions,
// their total is compared against the sender's CURRENT balance and a funding
// warning goes into the header when it is short -- the usual reason a send-many
// batch aborts with (err u1) ("sender does not have enough balance").
//
// Env:
//   API_URL   Stacks API to read the tx from; default https://api.hiro.so
//   FEE       fee (uSTX) for the replay; default max(original fee, 100000).
//             The original fee is often a SPONSOR's fee and too low for the
//             sender to get mined on its own -- raise it rather than lower it.
//   OUT       output path; default deployments/replay-<txid8>.<network>-plan.yaml
//
// Usage:
//   node scripts/tx-to-deployment.mjs <txid> [--out <path>] [--fee <ustx>]
//   pnpm deployment:from-tx 0x1c75d450…f31e
//
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const API_URL = process.env.API_URL ?? 'https://api.hiro.so';

const argv = process.argv.slice(2);
let txid = null;
let out = process.env.OUT ?? null;
let fee = process.env.FEE ? BigInt(process.env.FEE) : null;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--out') out = argv[++i];
  else if (a === '--fee') fee = BigInt(argv[++i]);
  else if (a.startsWith('-')) die(`unknown option ${a}`);
  else txid = a;
}
if (!txid) die('usage: node scripts/tx-to-deployment.mjs <txid> [--out <path>] [--fee <ustx>]');
txid = txid.startsWith('0x') ? txid : `0x${txid}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(txid)) die(`not a txid: ${txid}`);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const tx = await fetch(`${API_URL}/extended/v1/tx/${txid}`)
  .then((r) => (r.ok ? r.json() : r.text().then((t) => die(`GET tx ${txid}: ${r.status} ${t}`))))
  .catch((e) => die(`cannot reach ${API_URL}: ${e.message}`));

if (tx.tx_type !== 'contract_call') {
  die(
    `tx ${txid} is a ${tx.tx_type}, not a contract_call.\n`
    + '  Only contract calls can be replayed from a txid: a contract-publish plan\n'
    + '  needs the source on disk under contracts/, which is a deploy, not a replay.',
  );
}

const sender = tx.sender_address;
// Address version byte decides the plan network; the API URL does not have to.
const isMainnet = sender.startsWith('SP') || sender.startsWith('SM');
const network = isMainnet ? 'mainnet' : 'testnet';
const FEE = fee ?? (BigInt(tx.fee_rate) > 100000n ? BigInt(tx.fee_rate) : 100000n);

// STX the sender committed to sending, per its own post-conditions. Only the
// "at least this much" codes tell us anything about what the call needs.
const stxOwed = (tx.post_conditions ?? [])
  .filter((pc) => pc.type === 'stx'
    && pc.principal?.address === sender
    && ['sent_equal_to', 'sent_greater_than', 'sent_greater_than_or_equal_to'].includes(pc.condition_code))
  .reduce((sum, pc) => sum + BigInt(pc.amount), 0n);

const balance = await fetch(`${API_URL}/extended/v1/address/${sender}/balances`)
  .then((r) => (r.ok ? r.json() : null))
  .then((b) => (b ? BigInt(b.stx.balance) - BigInt(b.stx.locked ?? 0) : null))
  .catch(() => null);

const stx = (ustx) => `${(Number(ustx) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 })} STX`;

const notes = [];
notes.push(`#   txid    ${txid}`);
notes.push(`#   sender  ${sender} (nonce ${tx.nonce}${tx.sponsored ? `, sponsored by ${tx.sponsor_address}` : ''})`);
notes.push(`#   fee     ${tx.fee_rate} uSTX`);
notes.push(`#   status  ${tx.tx_status}${tx.tx_result?.repr ? ` -> ${tx.tx_result.repr}` : ''}`);
if (tx.vm_error) notes.push(`#   error   ${tx.vm_error}`);
if (tx.block_height) notes.push(`#   block   ${tx.block_height} (${tx.block_time_iso})`);

const caveats = [];
if (tx.sponsored) {
  caveats.push(
    `#   - NOT sponsored any more: ${sender} pays the fee itself. The original`,
    `#     ${tx.fee_rate} uSTX was ${tx.sponsor_address}'s fee; this plan uses ${FEE} uSTX.`,
  );
}
if ((tx.post_conditions ?? []).length) {
  caveats.push(
    `#   - the original ${tx.post_conditions.length} post-condition(s) are NOT reproduced:`,
    '#     clarinet broadcasts contract calls in post-condition mode `allow`.',
  );
  for (const pc of tx.post_conditions) {
    const who = pc.principal?.address ?? pc.principal?.type_id;
    const amount = pc.amount ? ` ${pc.amount}` : '';
    caveats.push(`#       ${who} ${pc.condition_code}${amount} (${pc.type})`);
  }
}
caveats.push(`#   - nonce ${tx.nonce} is spent; clarinet signs with the sender's next nonce.`);

const funding = [];
if (stxOwed > 0n) {
  funding.push(
    '#',
    `# The call moves at least ${stxOwed} uSTX (${stx(stxOwed)}) out of ${sender.slice(0, 8)}…`,
  );
  if (balance === null) {
    funding.push('# Could not read its current balance -- check it before applying.');
  } else if (balance < stxOwed + FEE) {
    funding.push(
      `# BEFORE APPLYING -- FUND THE SENDER. It holds ${balance} uSTX (${stx(balance)}),`,
      `# i.e. it is short ${stxOwed + FEE - balance} uSTX (${stx(stxOwed + FEE - balance)}) including the fee.`,
      '# Applying as-is repeats the failure ((err u1) = sender does not have enough balance).',
    );
  } else {
    funding.push(`# The sender holds ${balance} uSTX (${stx(balance)}) -- enough, as of writing.`);
  }
}

const args = tx.contract_call.function_args ?? [];
const parameters = args.length
  ? args
    .map((a) => `      # ${a.name}: ${a.type}\n      - |-\n${a.repr.split('\n').map((l) => `        ${l}`).join('\n')}`)
    .join('\n')
  : '      []';

const outPath = out
  ?? `deployments/replay-${txid.slice(2, 10)}.${network}-plan.yaml`;

const yaml = `# Replay of ${tx.contract_call.contract_id}::${tx.contract_call.function_name}
# Generated by scripts/tx-to-deployment.mjs -- do not hand-edit; regenerate with:
#   node scripts/tx-to-deployment.mjs ${txid}${out ? ` --out ${outPath}` : ''}
#
# Original transaction:
${notes.join('\n')}
#
# Differences from the original transaction:
${caveats.join('\n')}${funding.length ? `\n${funding.join('\n')}` : ''}
#
# Apply (keys come from the gitignored settings/${isMainnet ? 'Mainnet' : 'Testnet'}.toml):
#
#   clarinet deployments apply -d --no-dashboard -p ${outPath}
#
id: 0
name: Replay ${tx.contract_call.function_name} from ${txid.slice(0, 10)}
network: ${network}
stacks-node: ${API_URL}
bitcoin-node: ${isMainnet
    ? 'http://blockstack:blockstacksystem@bitcoin.blockstack.com:8332'
    : 'http://blockstack:blockstacksystem@bitcoind.testnet.stacks.co:18332'}
plan:
  batches:
  - id: 0
    transactions:
    - transaction-type: contract-call
      contract-id: ${tx.contract_call.contract_id}
      expected-sender: ${sender}
      method: ${tx.contract_call.function_name}
      cost: ${FEE}
      parameters:
${parameters}
`;

writeFileSync(outPath, yaml);
console.log(`wrote ${outPath}`);
console.log(`  ${tx.contract_call.contract_id}::${tx.contract_call.function_name} (${args.length} arg(s)), sender ${sender}, fee ${FEE} uSTX`);
if (stxOwed > 0n && balance !== null && balance < stxOwed + FEE) {
  console.log(`  ! sender is short ${stxOwed + FEE - balance} uSTX -- fund it before applying`);
}
if (dirname(outPath) !== 'deployments') {
  console.log(`  note: ${outPath} is outside deployments/; pass it with -p when applying`);
}
