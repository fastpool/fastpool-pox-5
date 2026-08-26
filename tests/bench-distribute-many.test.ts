// Cost benchmark for `distribute-rewards-many` at the 300-stacker batch bound.
//
// The distribution path makes no pox-5 calls at all, so the binding cost is the
// transfers themselves: one `stx-transfer?` per stacker on the swap path, and
// one sBTC `transfer` per stacker on the timeout path. This measures both
// against the block limits so the batch bound can be set from data rather than
// from a guess.
//
// Devnet.toml only funds a handful of wallets, so the 300 stackers here are
// derived from deterministic private keys and funded from the deployer. simnet
// does not verify signatures, so any principal with a balance can stake.
//
// Run with:  npx vitest run tests/bench-distribute-many.test.ts -- --costs
// Without `--costs` the simnet collects no cost data and only the pass/fail
// assertions below run.
import { Cl, privateKeyToAddress } from "@stacks/transactions";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MGR,
  POX5,
  armSwap,
  claimPot,
  deliverPot,
  deployer,
  advancePastCycle,
  currentCycle,
  distributeMany,
  expectOk,
  mgrPrincipal,
  quote,
  readNum,
  swap,
} from "./helpers/stx-rewards-fixture";
import { registerSigner } from "./helpers/rewards-fixture";

const BATCH = 300;
const STAKE = 10_000_000_000; // 10k STX each
const POT = 200_000_000;

/** 300 deterministic principals, funded and staked against the manager. */
function makeStackers(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const key = (i + 1).toString(16).padStart(64, "0") + "01";
    return privateKeyToAddress(key);
  });
}

const OUT_PATH = join(tmpdir(), "distribute-rewards-many-costs.txt");
const out: string[] = [];
const pct = (used: number, limit: number) => `${((used / limit) * 100).toFixed(1)}%`;

function report(label: string, costs: any) {
  if (!costs) {
    out.push(`${label}: no cost data (run with -- --costs)`);
    return;
  }
  const t = costs.total ?? costs;
  const l = costs.limit ?? {};
  const line = (k: string) =>
    `${k.padEnd(13)} ${String(t[k]).padStart(12)}${l[k] ? `  ${pct(Number(t[k]), Number(l[k])).padStart(6)} of block` : ""}`;
  out.push(
    [`${label}:`, ...["runtime", "readCount", "readLength", "writeCount", "writeLength"].map(
      (k) => `  ${line(k)}`,
    )].join("\n"),
  );
}

describe("cost: distribute-rewards-many at 300", () => {
  it(
    "pays 300 stackers in one transaction, on both the STX and the sBTC leg",
    { timeout: 300_000 },
    () => {
      const stackers = makeStackers(BATCH);
      registerSigner(deployer, MGR);
      armSwap();

      const cycle = currentCycle(deployer);
      const startBurnHt = readNum("reward-cycle-to-burn-height", [Cl.uint(cycle)]);
      stackers.forEach((who) => {
        simnet.transferSTX(STAKE + 1_000_000, who, deployer);
        const r = simnet.callPublicFn(
          POX5,
          "stake",
          [
            Cl.principal(mgrPrincipal()),
            Cl.uint(STAKE),
            Cl.uint(2),
            Cl.uint(startBurnHt),
            Cl.none(),
          ],
          who,
        );
        expect(r.result.type).toBe("ok");
      });

      const rewardCycle = cycle + 1;
      advancePastCycle(rewardCycle);
      deliverPot(POT);
      const pot = claimPot(rewardCycle);

      // --- STX leg: swap half, distribute it to all 300.
      const swapped = Math.floor(pot / 2);
      expectOk(swap(rewardCycle, swapped, quote(swapped)), "swap half");

      const stxRun = distributeMany(stackers, rewardCycle);
      expectOk(stxRun, "distribute STX leg");
      expect(Number((stxRun.result as any).value.value.paid.value)).toBe(BATCH);
      report("300 stackers, STX leg", (stxRun as any).costs);

      // --- sBTC leg: let the window close on the rest, distribute again.
      simnet.mineEmptyBurnBlocks(433);
      const sbtcRun = distributeMany(stackers, rewardCycle);
      expectOk(sbtcRun, "distribute sBTC leg");
      expect(Number((sbtcRun.result as any).value.value.paid.value)).toBe(BATCH);
      report("300 stackers, sBTC leg", (sbtcRun as any).costs);

      // --- and a no-op pass, which is the fold cost with nothing to pay.
      const noop = distributeMany(stackers, rewardCycle);
      expectOk(noop, "no-op pass");
      expect(Number((noop.result as any).value.value.paid.value)).toBe(0);
      report("300 stackers, nothing due", (noop as any).costs);

      writeFileSync(OUT_PATH, out.join("\n\n") + "\n");
    },
  );
});
