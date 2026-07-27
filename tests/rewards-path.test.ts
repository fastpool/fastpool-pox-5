import { Cl } from "@stacks/transactions";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  currentCycle,
  fundRewards,
  MANAGER,
  managerPrincipal,
  num,
  POX5,
  registerSigner,
  SBTC,
} from "./helpers/rewards-fixture";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const staker1 = accounts.get("wallet_1")!;
const staker2 = accounts.get("wallet_2")!;

const log: string[] = [];
const note = (...parts: unknown[]) => log.push(parts.join(" "));
const dump = () =>
  writeFileSync("/tmp/rewards-path.txt", log.join("\n") + "\n");

const sbtcBalance = (who: string) => {
  const cv = simnet.callReadOnlyFn(
    `${SBTC}.sbtc-token`,
    "get-balance",
    [Cl.principal(who)],
    deployer,
  ).result as any;
  return Number(cv.value.value);
};

const readNum = (fn: string, args: any[]) =>
  num(simnet.callReadOnlyFn(POX5, fn, args, deployer).result);

describe("reward distribution end to end", () => {
  it("stakes, earns, and pays out", () => {
    const manager = managerPrincipal(deployer);

    note("register-self ->", Cl.prettyPrint(registerSigner(deployer).result));

    // --- stake ---
    const cycle = currentCycle(deployer);
    const startBurnHt = readNum("reward-cycle-to-burn-height", [Cl.uint(cycle)]);
    const stakes: Array<[string, number]> = [
      [staker1, 100_000_000_000],
      [staker2, 300_000_000_000],
    ];
    for (const [who, amount] of stakes) {
      const r = simnet.callPublicFn(
        POX5,
        "stake",
        [
          Cl.principal(manager),
          Cl.uint(amount),
          Cl.uint(2),
          Cl.uint(startBurnHt),
          Cl.none(),
        ],
        who,
      );
      note(`stake ${amount} ->`, Cl.prettyPrint(r.result));
      expect(r.result.type).toBe("ok");
    }

    const rewardCycle = cycle + 1;
    note("current cycle", cycle, "-> reward cycle", rewardCycle);
    note(
      "signer shares",
      readNum("get-signer-shares-staked-for-cycle", [
        Cl.principal(manager),
        Cl.uint(rewardCycle),
        Cl.none(),
      ]),
    );
    for (const [who] of stakes) {
      note(
        "  staker shares",
        who.slice(-5),
        readNum("get-staker-shares-staked-for-cycle", [
          Cl.principal(who),
          Cl.uint(rewardCycle),
          Cl.none(),
          Cl.principal(manager),
        ]),
      );
    }

    // --- advance into the reward cycle ---
    // Advance PAST the reward cycle: `calculate-rewards` computes for the
    // cycle that has just ended, so we must be in cycle+1 for cycle's stakes
    // to be counted.
    const target = readNum("reward-cycle-to-burn-height", [
      Cl.uint(rewardCycle + 1),
    ]);
    simnet.mineEmptyBurnBlocks(Math.max(1, target - simnet.burnBlockHeight + 2));
    note("burn height", simnet.burnBlockHeight, "cycle", currentCycle(deployer));

    // --- rewards arrive as sBTC held by pox-5 ---
    const pot = 50_000_000;
    note("fund ->", Cl.prettyPrint(fundRewards(staker1, pot).result));
    note("get-rewards ->", readNum("get-rewards", []));
    note("get-new-rewards ->", readNum("get-new-rewards", []));

    const calc = simnet.callPublicFn(
      POX5,
      "calculate-rewards",
      [Cl.list([])],
      deployer,
    );
    note("calculate-rewards ->", Cl.prettyPrint(calc.result).slice(0, 200));

    note(
      "signer rpt",
      readNum("get-signer-rewards-per-token-for-cycle", [
        Cl.principal(manager),
        Cl.uint(rewardCycle),
        Cl.none(),
      ]),
    );
    for (const [who] of stakes) {
      note(
        "  earned",
        who.slice(-5),
        readNum("get-earned-staker-rewards", [
          Cl.principal(manager),
          Cl.uint(rewardCycle),
          Cl.none(),
          Cl.principal(who),
        ]),
      );
    }

    // --- manager pulls the pot, then distributes ---
    const claim = simnet.callPublicFn(
      MANAGER,
      "claim-rewards",
      [Cl.list([]), Cl.uint(rewardCycle)],
      deployer,
    );
    note("manager claim-rewards ->", Cl.prettyPrint(claim.result).slice(0, 200));
    note("manager sBTC", sbtcBalance(manager));

    const before = stakes.map(([who]) => sbtcBalance(who));
    const many = simnet.callPublicFn(
      MANAGER,
      "claim-staker-rewards-many",
      [
        Cl.list(stakes.map(([who]) => Cl.principal(who))),
        Cl.uint(rewardCycle),
        Cl.none(),
      ],
      deployer,
    );
    note("claim-staker-rewards-many ->", Cl.prettyPrint(many.result));
    if (many.costs) {
      const t = many.costs.total;
      note(
        "  costs: runtime=" + t.runtime,
        "readCount=" + t.readCount,
        "readLength=" + t.readLength,
        "writeCount=" + t.writeCount,
        "writeLength=" + t.writeLength,
      );
    }
    stakes.forEach(([who], i) => {
      note("  payout", who.slice(-5), sbtcBalance(who) - before[i]);
    });

    dump();
    expect(many.result.type).toBe("ok");
  });
});
