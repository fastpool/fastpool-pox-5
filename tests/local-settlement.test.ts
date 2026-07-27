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
const stakers = [1, 2, 3, 4, 5, 6, 7, 8].map(
  (i) => accounts.get(`wallet_${i}`)!,
);
const amounts = [
  100_000_000_000, 300_000_000_000, 55_000_000_000, 70_000_000_000,
  120_000_000_000, 90_000_000_000, 45_000_000_000, 210_000_000_000,
];
const POT = 50_000_000;

const readNum = (fn: string, args: any[]) =>
  num(simnet.callReadOnlyFn(POX5, fn, args, deployer).result);

const sbtcBalance = (who: string) =>
  Number(
    (
      simnet.callReadOnlyFn(
        `${SBTC}.sbtc-token`,
        "get-balance",
        [Cl.principal(who)],
        deployer,
      ).result as any
    ).value.value,
  );

/** Stake everyone, advance a cycle, deliver a reward pot, pull it in. */
function setup(numCycles = 2) {
  const manager = managerPrincipal(deployer);
  registerSigner(deployer);

  const cycle = currentCycle(deployer);
  const startBurnHt = readNum("reward-cycle-to-burn-height", [Cl.uint(cycle)]);
  stakers.forEach((who, i) => {
    const r = simnet.callPublicFn(
      POX5,
      "stake",
      [
        Cl.principal(manager),
        Cl.uint(amounts[i]),
        Cl.uint(numCycles),
        Cl.uint(startBurnHt),
        Cl.none(),
      ],
      who,
    );
    expect(r.result.type).toBe("ok");
  });

  const rewardCycle = cycle + 1;
  const target = readNum("reward-cycle-to-burn-height", [
    Cl.uint(rewardCycle + 1),
  ]);
  simnet.mineEmptyBurnBlocks(Math.max(1, target - simnet.burnBlockHeight + 2));

  fundRewards(stakers[0], POT);
  simnet.callPublicFn(POX5, "calculate-rewards", [Cl.list([])], deployer);

  return { manager, rewardCycle };
}

function pullPot(rewardCycle: number) {
  const r = simnet.callPublicFn(
    MANAGER,
    "claim-rewards",
    [Cl.list([]), Cl.uint(rewardCycle)],
    deployer,
  );
  expect(r.result.type).toBe("ok");
  return Number((r.result as any).value.value["total-rewards"].value);
}

const poxEarned = (manager: string, who: string, cycle: number) =>
  readNum("get-earned-staker-rewards", [
    Cl.principal(manager),
    Cl.uint(cycle),
    Cl.none(),
    Cl.principal(who),
  ]);

const localClaimable = (who: string, cycle: number) =>
  num(
    (
      simnet.callReadOnlyFn(
        MANAGER,
        "get-local-staker-rewards",
        [Cl.principal(who), Cl.uint(cycle)],
        deployer,
      ).result as any
    ).value.claimable,
  );

describe("locally-settled distribution", () => {
  it("mirrors pox-5's shares exactly", () => {
    const { manager, rewardCycle } = setup();
    const poxTotal = readNum("get-signer-pending-staked-ustx-per-cycle", [
      Cl.principal(manager),
      Cl.uint(rewardCycle),
    ]);
    expect(poxTotal).toBe(amounts.reduce((a, b) => a + b, 0));
    // per-staker mirror agrees with pox-5
    stakers.forEach((who, i) => {
      expect(
        readNum("get-staker-shares-staked-for-cycle", [
          Cl.principal(who),
          Cl.uint(rewardCycle),
          Cl.none(),
          Cl.principal(manager),
        ]),
      ).toBe(amounts[i]);
    });
  });

  it("splits the pot the same way pox-5 would, and pays it out", () => {
    const { manager, rewardCycle } = setup();
    const pot = pullPot(rewardCycle);

    // ground truth from pox-5 vs our local computation
    const pox = stakers.map((w) => poxEarned(manager, w, rewardCycle));
    const local = stakers.map((w) => localClaimable(w, rewardCycle));
    // pox-5 floors `shares * (rpt - rpt_paid) / PRECISION` per staker; we floor
    // `pot * shares / total`. The two can differ by a satoshi of rounding, but
    // ours must never exceed pox-5's, and the split must never over-distribute.
    local.forEach((v, i) => {
      expect(v).toBeLessThanOrEqual(pox[i]);
      expect(pox[i] - v).toBeLessThanOrEqual(1);
    });
    expect(local.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(pot);

    const before = stakers.map(sbtcBalance);
    const res = simnet.callPublicFn(
      MANAGER,
      "distribute-rewards-many",
      [Cl.list(stakers.map((w) => Cl.principal(w))), Cl.uint(rewardCycle)],
      deployer,
    );
    expect(res.result.type).toBe("ok");
    const paid = stakers.map((w, i) => sbtcBalance(w) - before[i]);
    expect(paid).toEqual(local);

    // a second run pays nothing more
    const before2 = stakers.map(sbtcBalance);
    simnet.callPublicFn(
      MANAGER,
      "distribute-rewards-many",
      [Cl.list(stakers.map((w) => Cl.principal(w))), Cl.uint(rewardCycle)],
      deployer,
    );
    expect(stakers.map((w, i) => sbtcBalance(w) - before2[i])).toEqual(
      stakers.map(() => 0),
    );
  });

  // simnet resets between tests, so the two paths are measured in separate
  // tests over identical setups and compared at the end.
  const costs: Record<string, any> = {};

  it("cost: locally-settled distribution", () => {
    const { rewardCycle } = setup();
    pullPot(rewardCycle);
    const r = simnet.callPublicFn(
      MANAGER,
      "distribute-rewards-many",
      [Cl.list(stakers.map((w) => Cl.principal(w))), Cl.uint(rewardCycle)],
      deployer,
    );
    expect(r.result.type).toBe("ok");
    costs.local = r.costs?.total;
  });

  it("cost: pox-5-settled distribution", () => {
    const { rewardCycle } = setup();
    pullPot(rewardCycle);
    const r = simnet.callPublicFn(
      MANAGER,
      "claim-staker-rewards-many",
      [
        Cl.list(stakers.map((w) => Cl.principal(w))),
        Cl.uint(rewardCycle),
        Cl.none(),
      ],
      deployer,
    );
    expect(r.result.type).toBe("ok");
    costs.pox5 = r.costs?.total;

    if (costs.local && costs.pox5) {
      const { local, pox5 } = costs;
      writeFileSync(
        "/tmp/local-vs-pox5-costs.txt",
        [
          `stakers: ${stakers.length}`,
          `via pox-5:  readLength=${pox5.readLength} readCount=${pox5.readCount} runtime=${pox5.runtime}`,
          `local:      readLength=${local.readLength} readCount=${local.readCount} runtime=${local.runtime}`,
          `readLength ratio: ${(pox5.readLength / local.readLength).toFixed(1)}x`,
        ].join("\n") + "\n",
      );
      expect(local.readLength).toBeLessThan(pox5.readLength);
    }
  });

  it("refuses to mix settlement paths for one cycle", () => {
    const { rewardCycle } = setup();
    pullPot(rewardCycle);
    simnet.callPublicFn(
      MANAGER,
      "distribute-rewards-many",
      [Cl.list([Cl.principal(stakers[0])]), Cl.uint(rewardCycle)],
      deployer,
    );
    // pox-5 settlement for the same cycle would pay the same rewards twice
    const clash = simnet.callPublicFn(
      MANAGER,
      "claim-staker-rewards-many",
      [Cl.list([Cl.principal(stakers[1])]), Cl.uint(rewardCycle), Cl.none()],
      deployer,
    );
    expect(clash.result).toBeErr(Cl.uint(1013));
  });

  it("an unstake cannot disturb the cycle being distributed", () => {
    const { manager, rewardCycle } = setup();
    pullPot(rewardCycle);
    const sharesBefore = readNum("get-signer-pending-staked-ustx-per-cycle", [
      Cl.principal(manager),
      Cl.uint(rewardCycle),
    ]);

    expect(
      simnet.callPublicFn(
        POX5,
        "unstake",
        [Cl.principal(managerPrincipal(deployer))],
        stakers[2],
      ).result.type,
    ).toBe("ok");

    // pox-5 only removes a staker from cycles AFTER the current one, so the
    // cycle being paid out is frozen and the mirror stays exact for it.
    expect(
      readNum("get-signer-pending-staked-ustx-per-cycle", [
        Cl.principal(manager),
        Cl.uint(rewardCycle),
      ]),
    ).toBe(sharesBefore);
    expect(
      simnet.callPublicFn(
        MANAGER,
        "distribute-rewards-many",
        [Cl.list(stakers.map((w) => Cl.principal(w))), Cl.uint(rewardCycle)],
        deployer,
      ).result.type,
    ).toBe("ok");
  });

  it("trips the mirror check on a future cycle the staker left", () => {
    // Stake over six cycles so there are still mirrored cycles ahead of the
    // current one for the unstake to silently remove.
    const { rewardCycle } = setup(6);
    expect(
      simnet.callPublicFn(
        POX5,
        "unstake",
        [Cl.principal(managerPrincipal(deployer))],
        stakers[2],
      ).result.type,
    ).toBe("ok");

    const res = simnet.callPublicFn(
      MANAGER,
      "distribute-rewards-many",
      [
        Cl.list(stakers.map((w) => Cl.principal(w))),
        Cl.uint(rewardCycle + 2),
      ],
      deployer,
    );
    expect(res.result).toBeErr(Cl.uint(1012));
  });
});
