if(process.argv.includes('--recovery')) { await (await import('./_vault-recovery-v6-3.mjs')).runRecoveryMatrix('fastpool'); process.exit(0); }
import { runPoolVaultFork, runPoolVaultLifecycle } from './_pool-vault-stxer.mjs';
import { fileURLToPath } from 'node:url';
const run=(process.argv.includes('--lifecycle')||process.argv.includes('--maker'))?runPoolVaultLifecycle:runPoolVaultFork;
await run({profile:process.argv.includes('--maker')?'maker':'liquidation',kind:'fastpool',
 poolSource:fileURLToPath(new URL('../contracts/signer-manager-vault-stx-rewards.clar',import.meta.url)),
 vaultSource:fileURLToPath(new URL('../contracts/fastpool-swap-vault.clar',import.meta.url)),
 resultDirectory:process.env.SIM_RESULTS_DIR||fileURLToPath(new URL('./results/pool-vault-stx',import.meta.url))});
