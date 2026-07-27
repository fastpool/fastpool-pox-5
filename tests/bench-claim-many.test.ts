// Cost benchmark for `claim-staker-rewards-many`: the current fold
// implementation (batch invariants hoisted out of the loop) against the
// previous `map` + context-data-vars implementation.
//
// Both contracts are deployed side by side into the same simnet, so the
// comparison is between two complete, real contracts rather than a sketch.
// The previous version is read from git (the last committed/staged revision of
// the contract); the benchmark skips itself if that revision no longer contains
// the old implementation.
//
// Run with:  npx vitest run tests/bench-claim-many.test.ts -- --costs
// Without `--costs` the simnet does not collect cost data and this no-ops.
import { Cl, ClarityVersion } from "@stacks/transactions";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const caller = accounts.get("wallet_1")!;

const current = readFileSync("contracts/fastpool-signer-manager.clar", "utf8");
const previous = execSync("git show :contracts/fastpool-signer-manager.clar", {
  encoding: "utf8",
});

const CURRENT = "bench-current";
const PREVIOUS = "bench-previous";
const OUT_PATH = join(tmpdir(), "claim-staker-rewards-many-costs.txt");

const out: string[] = [];
const log = (line: string) => {
  out.push(line);
  console.log(line);
};
const pad = (s: string | number, n: number) => String(s).padEnd(n);

describe("cost: claim-staker-rewards-many", () => {
  it("fold with hoisted invariants vs map with context vars", { timeout: 120_000 }, () => {
    if (!previous.includes("(map fn-claim-staker-rewards stakers)")) {
      log("previous revision no longer has the map implementation; nothing to compare");
      writeFileSync(OUT_PATH, out.join("\n"));
      return;
    }
    for (const [name, source] of [
      [PREVIOUS, previous],
      [CURRENT, current],
    ] as const) {
      simnet.deployContract(
        name,
        source,
        { clarityVersion: ClarityVersion.Clarity6 },
        deployer,
      );
    }

    const stakers = Array.from({ length: 100 }, (_, i) =>
      Cl.principal(accounts.get(`wallet_${(i % 8) + 1}`)!),
    );

    const cases: Array<[string, string]> = [
      ["previous (map + ctx vars)", PREVIOUS],
      ["current  (fold + hoisted)", CURRENT],
    ];

    const probe = simnet.callPublicFn(
      CURRENT,
      "claim-staker-rewards-many",
      [Cl.list([]), Cl.uint(1), Cl.none()],
      caller,
    );
    if (!probe.costs) {
      log("no cost data: re-run with `-- --costs`");
      writeFileSync(OUT_PATH, out.join("\n"));
      return;
    }
    log(`block limits: ${JSON.stringify(probe.costs.limit)}`);

    for (const n of [1, 10, 50, 100]) {
      log(`\n=== n = ${n} stakers ===`);
      log(
        `${pad("variant", 28)}${pad("runtime", 12)}${pad("readCount", 11)}${pad("readLength", 12)}${pad("writeCount", 12)}${pad("writeLength", 12)}`,
      );
      for (const [label, contract] of cases) {
        const { costs } = simnet.callPublicFn(
          contract,
          "claim-staker-rewards-many",
          [Cl.list(stakers.slice(0, n)), Cl.uint(1), Cl.none()],
          caller,
        );
        const t = costs!.total;
        log(
          `${pad(label, 28)}${pad(t.runtime, 12)}${pad(t.readCount, 11)}${pad(t.readLength, 12)}${pad(t.writeCount, 12)}${pad(t.writeLength, 12)}`,
        );
      }
    }
    writeFileSync(OUT_PATH, `${out.join("\n")}\n`);
    console.log(`\nwritten to ${OUT_PATH}`);
  });
});
