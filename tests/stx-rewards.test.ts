import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  ADAPTER,
  MGR,
  ORACLE,
  POT,
  RATE,
  adapterPrincipal,
  amounts,
  armSwap,
  advancePastCycle,
  claimPot,
  deliverPot,
  deployer,
  distribute,
  distributeMany,
  checkMirror,
  mgrNum,
  mgrPrincipal,
  mgrRead,
  oraclePrincipal,
  POX5,
  quote,
  readNum,
  sbtcBalance,
  setup,
  stackerRewards,
  stackers,
  stxBalance,
  swap,
  swapStatus,
  expectOk,
} from "./helpers/stx-rewards-fixture";

const errCode = (r: any) => Number((r.result as any).value.value);
const total = amounts.reduce((a, b) => a + b, 0);

/** Claim, arm the DEX, pin. Returns the pot actually pulled in. */
function ready(numCycles = 2) {
  const { rewardCycle } = setup(numCycles);
  armSwap();
  const pot = claimPot(rewardCycle);
  return { rewardCycle, pot };
}

describe("mirror and pinning", () => {
  it("mirrors pox-5's shares exactly and pins the denominator", () => {
    const { rewardCycle } = setup();
    const mirror = checkMirror(rewardCycle);
    expect(mirror.matches).toBe(true);
    expect(mirror.local).toBe(total);

    claimPot(rewardCycle);
    expectOk(
      simnet.callPublicFn(MGR, "pin-shares", [Cl.uint(rewardCycle)], deployer),
      "pin-shares",
    );
    expect(swapStatus(rewardCycle).totalShares).toBe(total);
    expect(swapStatus(rewardCycle).pinned).toBe(true);
  });

  it("refuses to pin a cycle that was never claimed", () => {
    const { rewardCycle } = setup();
    const r = simnet.callPublicFn(MGR, "pin-shares", [Cl.uint(rewardCycle)], deployer);
    expect(errCode(r)).toBe(1020); // ERR_CYCLE_NOT_CLAIMED
  });

  it("refuses to repair a pinned cycle", () => {
    const { rewardCycle } = ready();
    expectOk(simnet.callPublicFn(MGR, "pin-shares", [Cl.uint(rewardCycle)], deployer), "pin");
    const r = simnet.callPublicFn(
      MGR,
      "repair-mirror-many",
      [Cl.list([Cl.principal(stackers[0])]), Cl.uint(rewardCycle)],
      deployer,
    );
    expect(errCode(r)).toBe(1012); // ERR_SHARES_ALREADY_PINNED
  });

  it("repairs a mirror that drifted from a mid-lock unstake, then pins", () => {
    // Lock for three cycles, so a mid-lock unstake strands a future cycle in
    // the mirror without pox-5 ever calling back.
    const { rewardCycle } = setup(3);
    const driftedCycle = rewardCycle + 2;

    const un = simnet.callPublicFn(
      POX5,
      "unstake",
      [Cl.principal(mgrPrincipal())],
      stackers[0],
    );
    expectOk(un, "unstake");

    advancePastCycle(driftedCycle);
    deliverPot();
    claimPot(driftedCycle);

    const before = checkMirror(driftedCycle);
    expect(before.matches).toBe(false);
    expect(before.local).toBeGreaterThan(before.pox5);

    const failed = simnet.callPublicFn(MGR, "pin-shares", [Cl.uint(driftedCycle)], deployer);
    expect(errCode(failed)).toBe(1008); // ERR_SHARE_MIRROR_MISMATCH

    expectOk(
      simnet.callPublicFn(
        MGR,
        "repair-mirror-many",
        [Cl.list([Cl.principal(stackers[0])]), Cl.uint(driftedCycle)],
        deployer,
      ),
      "repair",
    );

    expect(checkMirror(driftedCycle).matches).toBe(true);
    expectOk(
      simnet.callPublicFn(MGR, "pin-shares", [Cl.uint(driftedCycle)], deployer),
      "pin after repair",
    );
    expect(mgrNum("get-mirrored-shares", [Cl.principal(stackers[0]), Cl.uint(driftedCycle)])).toBe(0);
  });
});

describe("validate-stake! guards", () => {
  it("refuses staking calldata, since there is no L1 payout path here", () => {
    simnet.callPublicFn(MGR, "set-operator", [Cl.principal(deployer)], deployer);
    setup();
    const cycle = readNum("current-pox-reward-cycle", []);
    const startBurnHt = readNum("reward-cycle-to-burn-height", [Cl.uint(cycle)]);
    const r = simnet.callPublicFn(
      POX5,
      "stake",
      [
        Cl.principal(mgrPrincipal()),
        Cl.uint(10_000_000_000),
        Cl.uint(1),
        Cl.uint(startBurnHt),
        Cl.some(Cl.bufferFromHex("00")),
      ],
      stackers[0],
    );
    // pox-5 propagates the callback's error verbatim through `try!`.
    expect(errCode(r)).toBe(1016); // ERR_CALLDATA_NOT_SUPPORTED
  });
});

describe("swap", () => {
  it("swaps the whole pot and pays every stacker STX pro-rata", () => {
    const { rewardCycle, pot } = ready();
    const expected = quote(pot);
    expectOk(swap(rewardCycle, pot, expected), "swap");

    const status = swapStatus(rewardCycle);
    expect(status.swappedSats).toBe(pot);
    expect(status.remainingSats).toBe(0);
    expect(status.stxOut).toBe(expected);
    expect(mgrNum("get-unswapped-sats")).toBe(0);
    expect(mgrNum("get-unpaid-stx")).toBe(expected);

    const before = stackers.map(stxBalance);
    const r = distributeMany(stackers, rewardCycle);
    expectOk(r, "distribute-rewards-many");
    const paid = stackers.map((w, i) => stxBalance(w) - before[i]);

    // Everyone gets their share of the same fill, floored.
    stackers.forEach((_, i) => {
      expect(paid[i]).toBe(Math.floor((expected * amounts[i]) / total));
    });
    // The pot is fully accounted for: payouts plus the rounding dust left behind.
    const dust = expected - paid.reduce((a, b) => a + b, 0);
    expect(dust).toBeGreaterThanOrEqual(0);
    expect(dust).toBeLessThan(stackers.length);
    expect(mgrNum("get-unpaid-stx")).toBe(dust);
  });

  it("splits one pot across several legs and pays the increment each time", () => {
    const { rewardCycle, pot } = ready();
    const legA = Math.floor(pot / 3);
    const legB = pot - legA;

    expectOk(swap(rewardCycle, legA, quote(legA)), "leg A");
    const afterA = stackerRewards(stackers[0], rewardCycle);
    expect(afterA["stx-due"]).toBe(
      Math.floor((quote(legA) * amounts[0]) / total),
    );

    const before = stxBalance(stackers[0]);
    expectOk(distribute(stackers[0], rewardCycle), "distribute after leg A");
    expect(stxBalance(stackers[0]) - before).toBe(afterA["stx-due"]);

    // Second leg through the same adapter; the watermark means only the
    // difference is paid out.
    expectOk(swap(rewardCycle, legB, quote(legB)), "leg B");
    const due = stackerRewards(stackers[0], rewardCycle)["stx-due"];
    const before2 = stxBalance(stackers[0]);
    expectOk(distribute(stackers[0], rewardCycle), "distribute after leg B");
    expect(stxBalance(stackers[0]) - before2).toBe(due);

    expect(stackerRewards(stackers[0], rewardCycle)["stx-due"]).toBe(0);
    expect(swapStatus(rewardCycle).remainingSats).toBe(0);
  });

  it("re-distributing a stacker with nothing due is an error, not a second payment", () => {
    const { rewardCycle, pot } = ready();
    expectOk(swap(rewardCycle, pot, quote(pot)), "swap");
    expectOk(distribute(stackers[0], rewardCycle), "first");
    const balance = stxBalance(stackers[0]);
    const r = distribute(stackers[0], rewardCycle);
    expect(errCode(r)).toBe(1013); // ERR_NOTHING_TO_DISTRIBUTE
    expect(stxBalance(stackers[0])).toBe(balance);
  });

  it("takes the fee in sBTC before the DEX sees anything, and it is withdrawable", () => {
    const { rewardCycle } = setup();
    armSwap();
    expectOk(simnet.callPublicFn(MGR, "update-fees", [Cl.uint(500)], deployer), "fees");
    const pot = claimPot(rewardCycle);

    const fee = Math.floor((pot * 500) / 10_000);
    const net = pot - fee;
    expectOk(swap(rewardCycle, pot, quote(net)), "swap");

    expect(mgrNum("get-earned-fees")).toBe(fee);
    expect(swapStatus(rewardCycle).feeSats).toBe(fee);
    // Only the net reached the DEX.
    expect(swapStatus(rewardCycle).stxOut).toBe(quote(net));

    const before = sbtcBalance(deployer);
    expectOk(
      simnet.callPublicFn(
        MGR,
        "withdraw-fees",
        [Cl.uint(fee), Cl.principal(deployer)],
        deployer,
      ),
      "withdraw-fees",
    );
    expect(sbtcBalance(deployer) - before).toBe(fee);
    expect(mgrNum("get-earned-fees")).toBe(0);
  });

  it("treats the baseline as informational until an admin switches it on", () => {
    const { rewardCycle, pot } = ready();
    expect(mgrRead("get-enforce-price-floor", []).type).toBe("false");
    // Far below the baseline, and it still goes through: the floor is off.
    expectOk(swap(rewardCycle, pot, 1), "unenforced");
    // ...and the swap still happened at the market's price, not the floor's.
    expect(swapStatus(rewardCycle).stxOut).toBe(quote(pot));
  });

  it("enforces the baseline floor once switched on", () => {
    const { rewardCycle, pot } = ready();
    expectOk(
      simnet.callPublicFn(MGR, "set-enforce-price-floor", [Cl.bool(true)], deployer),
      "enable floor",
    );
    const floor = Math.floor((quote(pot) * 8000) / 10_000); // 20% default tolerance
    expect(errCode(swap(rewardCycle, pot, floor - 1))).toBe(1017); // ERR_MIN_OUT_TOO_LOW
    expectOk(swap(rewardCycle, pot, floor), "at the floor");
  });

  it("does not let a dead oracle block a swap while the floor is off", () => {
    const { rewardCycle, pot } = ready();
    // Rate 0 makes the dummy quote 0, which is the closest stand-in for an
    // oracle with nothing useful to say.
    expectOk(simnet.callPublicFn(ORACLE, "set-rate", [Cl.uint(0)], deployer), "zero rate");
    expectOk(swap(rewardCycle, pot, quote(pot)), "swap without a usable baseline");
    expect(swapStatus(rewardCycle).stxOut).toBe(quote(pot));
  });

  it("rejects an unlisted adapter, a wrong oracle, and a non-operator caller", () => {
    const { rewardCycle, pot } = ready();
    expect(
      errCode(swap(rewardCycle, pot, quote(pot), deployer, `${deployer}.price-oracle-dummy`)),
    ).toBe(1006); // ERR_ADAPTER_NOT_ALLOWED
    expect(
      errCode(
        swap(rewardCycle, pot, quote(pot), deployer, adapterPrincipal(), adapterPrincipal()),
      ),
    ).toBe(1018); // ERR_WRONG_ORACLE
    expect(errCode(swap(rewardCycle, pot, quote(pot), stackers[1]))).toBe(1002); // ERR_UNAUTHORIZED_OPERATOR
  });

  it("reverts the whole transaction when the adapter under-delivers", () => {
    const { rewardCycle, pot } = ready();
    expectOk(simnet.callPublicFn(ADAPTER, "set-mode", [Cl.uint(1)], deployer), "mode");
    const r = swap(rewardCycle, pot, quote(pot));
    expect(errCode(r)).toBe(1007); // ERR_SLIPPAGE
    // Nothing moved: the pot is intact and no STX was credited.
    expect(swapStatus(rewardCycle).swappedSats).toBe(0);
    expect(mgrNum("get-unswapped-sats")).toBe(pot);
    expect(mgrNum("get-unpaid-stx")).toBe(0);
  });

  it("refuses to swap more than the pot has left", () => {
    const { rewardCycle, pot } = ready();
    expect(errCode(swap(rewardCycle, pot + 1, quote(pot + 1)))).toBe(1009);
    expectOk(swap(rewardCycle, pot, quote(pot)), "exact pot");
    expect(errCode(swap(rewardCycle, 1, 0))).toBe(1009); // nothing left
  });

  it("hands swap rights to a rotated operator and takes them from the old one", () => {
    const { rewardCycle, pot } = ready();
    expectOk(
      simnet.callPublicFn(MGR, "set-operator", [Cl.principal(stackers[1])], deployer),
      "set-operator",
    );
    expect(errCode(swap(rewardCycle, pot, quote(pot), deployer))).toBe(1002);
    expectOk(swap(rewardCycle, pot, quote(pot), stackers[1]), "new operator swaps");
  });
});

describe("the 3-day swap window", () => {
  it("holds the sBTC leg at zero while the window is open", () => {
    const { rewardCycle } = ready();
    expect(swapStatus(rewardCycle).windowOpen).toBe(true);
    const due = stackerRewards(stackers[0], rewardCycle);
    expect(due["sbtc-due"]).toBe(0);
    expect(due["sbtc-gross-due"]).toBe(0);
    // ...even though the pot is entirely unswapped.
    expect(swapStatus(rewardCycle).remainingSats).toBeGreaterThan(0);
  });

  it("pays the whole pot as sBTC, net of fees, when the operator never swaps", () => {
    const { rewardCycle } = setup();
    armSwap();
    expectOk(simnet.callPublicFn(MGR, "update-fees", [Cl.uint(500)], deployer), "fees");
    const pot = claimPot(rewardCycle);

    simnet.mineEmptyBurnBlocks(433);
    expect(swapStatus(rewardCycle).windowOpen).toBe(false);
    expect(errCode(swap(rewardCycle, pot, quote(pot)))).toBe(1010); // ERR_SWAP_WINDOW_CLOSED

    const before = stackers.map(sbtcBalance);
    expectOk(distributeMany(stackers, rewardCycle), "distribute");
    const paid = stackers.map((w, i) => sbtcBalance(w) - before[i]);

    let fees = 0;
    stackers.forEach((_, i) => {
      const gross = Math.floor((pot * amounts[i]) / total);
      const fee = Math.floor((gross * 500) / 10_000);
      fees += fee;
      expect(paid[i]).toBe(gross - fee);
    });
    expect(mgrNum("get-earned-fees")).toBe(fees);
    // Nothing was ever swapped, so no STX is owed to anyone.
    expect(mgrNum("get-unpaid-stx")).toBe(0);
  });

  it("pays both legs when the window closes mid-route", () => {
    const { rewardCycle, pot } = ready();
    const swapped = Math.floor(pot / 2);
    expectOk(swap(rewardCycle, swapped, quote(swapped)), "half");

    simnet.mineEmptyBurnBlocks(433);
    const leftover = pot - swapped;

    const stxBefore = stackers.map(stxBalance);
    const sbtcBefore = stackers.map(sbtcBalance);
    expectOk(distributeMany(stackers, rewardCycle), "distribute both legs");

    stackers.forEach((w, i) => {
      expect(stxBalance(w) - stxBefore[i]).toBe(
        Math.floor((quote(swapped) * amounts[i]) / total),
      );
      expect(sbtcBalance(w) - sbtcBefore[i]).toBe(
        Math.floor((leftover * amounts[i]) / total),
      );
    });
    expect(swapStatus(rewardCycle).remainingSats).toBe(leftover);
  });
});

describe("reserves and sweeps", () => {
  it("never lets a sweep reach sBTC or STX owed to stackers", () => {
    const { rewardCycle, pot } = ready();
    // Whole pot pulled in, nothing swapped: it is all stacker liability.
    expect(mgrNum("get-unswapped-sats")).toBe(pot);
    expect(errCode(simnet.callPublicFn(MGR, "sweep-sbtc-dust", [Cl.principal(deployer)], deployer))).toBe(
      1014, // ERR_NO_DUST
    );

    expectOk(swap(rewardCycle, pot, quote(pot)), "swap");
    // Now it is all STX liability instead.
    expect(errCode(simnet.callPublicFn(MGR, "sweep-stx-dust", [Cl.principal(deployer)], deployer))).toBe(
      1014,
    );

    expectOk(distributeMany(stackers, rewardCycle), "distribute");

    // What is left is the floor-division remainder, and it stays reserved:
    // `unpaid-stx` is only reduced by what stackers were actually paid, so the
    // remainder is inside the liability and no sweep can reach it. That
    // strands well under a micro-STX per stacker per cycle, and buys the
    // guarantee that an admin call can never touch stacker funds.
    expect(stxBalance(mgrPrincipal())).toBe(mgrNum("get-unpaid-stx"));
    expect(
      errCode(simnet.callPublicFn(MGR, "sweep-stx-dust", [Cl.principal(deployer)], deployer)),
    ).toBe(1014);
  });

  it("recovers STX that arrived outside the reward path", () => {
    const { rewardCycle, pot } = ready();
    expectOk(swap(rewardCycle, pot, quote(pot)), "swap");
    expectOk(distributeMany(stackers, rewardCycle), "distribute");

    const stray = 7_000_000;
    simnet.transferSTX(stray, mgrPrincipal(), stackers[3]);

    const before = stxBalance(deployer);
    expectOk(
      simnet.callPublicFn(MGR, "sweep-stx-dust", [Cl.principal(deployer)], deployer),
      "sweep stray",
    );
    expect(stxBalance(deployer) - before).toBe(stray);
    // The reserved remainder is still untouched.
    expect(stxBalance(mgrPrincipal())).toBe(mgrNum("get-unpaid-stx"));
  });
});
