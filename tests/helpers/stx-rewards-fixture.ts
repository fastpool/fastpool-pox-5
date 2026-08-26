// Drives pox-5 far enough to produce real, non-zero rewards for
// `fastpool-stx-rewards-signer-manager` in simnet, and arms the mock DEX + dummy oracle so the
// swap path can be exercised end to end.
import { Cl, ClarityValue, cvToValue } from "@stacks/transactions";
import { expect } from "vitest";
import { currentCycle, fundRewards, num, POX5, registerSigner, SBTC } from "./rewards-fixture";

export { POX5, SBTC, num, currentCycle, fundRewards };

export const MGR = "fastpool-stx-rewards-signer-manager";
export const ORACLE = "price-oracle-dummy";
export const ADAPTER = "mock-dex-adapter";

/** micro-STX per satoshi, scaled by 1e8 (the oracle's and mock's SCALE). */
export const RATE = 300 * 100_000_000;
/** STX handed to the mock pool so it has something to sell. */
export const POOL_STX = 1_000_000_000_000;

export const accounts = simnet.getAccounts();
export const deployer = accounts.get("deployer")!;
export const stackers = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => accounts.get(`wallet_${i}`)!);
export const amounts = [
  100_000_000_000, 300_000_000_000, 55_000_000_000, 70_000_000_000,
  120_000_000_000, 90_000_000_000, 45_000_000_000, 210_000_000_000,
];
export const POT = 50_000_000;

export const mgrPrincipal = () => `${deployer}.${MGR}`;
export const oraclePrincipal = () => `${deployer}.${ORACLE}`;
export const adapterPrincipal = () => `${deployer}.${ADAPTER}`;

export const readNum = (fn: string, args: ClarityValue[]) =>
  num(simnet.callReadOnlyFn(POX5, fn, args, deployer).result);

export const mgrRead = (fn: string, args: ClarityValue[]) =>
  simnet.callReadOnlyFn(MGR, fn, args, deployer).result;

export const mgrNum = (fn: string, args: ClarityValue[] = []) => num(mgrRead(fn, args));

export const sbtcBalance = (who: string) =>
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

export const stxBalance = (who: string) =>
  Number(simnet.getAssetsMap().get("STX")?.get(who) ?? 0n);

// `cvToValue` unwraps only the outer tuple: each field is still a
// `{ type, value }` pair, so every read below goes one level deeper.
const fields = (cv: ClarityValue) => cvToValue(cv, true) as Record<string, { value: any }>;

/** `get-stacker-rewards`, as a plain object of numbers. */
export function stackerRewards(who: string, cycle: number) {
  const t = fields(mgrRead("get-stacker-rewards", [Cl.principal(who), Cl.uint(cycle)]));
  return Object.fromEntries(
    Object.entries(t).map(([k, v]) => [k, Number(v.value)]),
  ) as Record<string, number>;
}

export function swapStatus(cycle: number) {
  const t = fields(mgrRead("get-swap-status", [Cl.uint(cycle)]));
  return {
    potSats: Number(t["pot-sats"].value),
    swappedSats: Number(t["swapped-sats"].value),
    remainingSats: Number(t["remaining-sats"].value),
    feeSats: Number(t["fee-sats"].value),
    stxOut: Number(t["stx-out"].value),
    totalShares: Number(t["total-shares"].value),
    deadline: Number(t.deadline.value),
    pinned: t.pinned.value === true,
    windowOpen: t["window-open"].value === true,
  };
}

export function checkMirror(cycle: number) {
  const t = fields(mgrRead("check-mirror", [Cl.uint(cycle)]));
  return {
    local: Number(t.local.value),
    pox5: Number(t["pox-5"].value),
    matches: t.matches.value === true,
  };
}

export const expectOk = (r: any, label: string) => {
  if (r.result.type !== "ok") throw new Error(`${label}: ${Cl.prettyPrint(r.result)}`);
  return r.result;
};

/** Stake everyone against the manager, run the cycle out, deliver a reward pot. */
export function setup(numCycles = 2) {
  registerSigner(deployer, MGR);

  const cycle = currentCycle(deployer);
  const startBurnHt = readNum("reward-cycle-to-burn-height", [Cl.uint(cycle)]);
  stackers.forEach((who, i) => {
    const r = simnet.callPublicFn(
      POX5,
      "stake",
      [
        Cl.principal(mgrPrincipal()),
        Cl.uint(amounts[i]),
        Cl.uint(numCycles),
        Cl.uint(startBurnHt),
        Cl.none(),
      ],
      who,
    );
    expect(r.result.type, `stake ${i}`).toBe("ok");
  });

  const rewardCycle = cycle + 1;
  advancePastCycle(rewardCycle);
  deliverPot();
  return { manager: mgrPrincipal(), rewardCycle, firstCycle: rewardCycle };
}

/** Mine until `cycle` is over. */
export function advancePastCycle(cycle: number) {
  const target = readNum("reward-cycle-to-burn-height", [Cl.uint(cycle + 1)]);
  simnet.mineEmptyBurnBlocks(Math.max(1, target - simnet.burnBlockHeight + 2));
}

/** Move sBTC into pox-5 and crystallize it into rewards. */
export function deliverPot(amount = POT) {
  fundRewards(stackers[0], amount);
  simnet.callPublicFn(POX5, "calculate-rewards", [Cl.list([])], deployer);
}

export function claimPot(cycle: number) {
  const r = simnet.callPublicFn(MGR, "claim-rewards", [Cl.uint(cycle)], deployer);
  expectOk(r, `claim-rewards ${cycle}`);
  return Number((r.result as any).value.value);
}

/** Point the manager at the dummy oracle and mock adapter, and stock the pool. */
export function armSwap(rate = RATE, pool = POOL_STX) {
  expectOk(simnet.callPublicFn(ORACLE, "set-rate", [Cl.uint(rate)], deployer), "oracle set-rate");
  expectOk(simnet.callPublicFn(ADAPTER, "set-rate", [Cl.uint(rate)], deployer), "adapter set-rate");
  expectOk(simnet.callPublicFn(ADAPTER, "fund", [Cl.uint(pool)], deployer), "adapter fund");
  expectOk(
    simnet.callPublicFn(MGR, "set-price-oracle", [Cl.principal(oraclePrincipal())], deployer),
    "set-price-oracle",
  );
  expectOk(
    simnet.callPublicFn(
      MGR,
      "set-dex-adapter",
      [Cl.principal(adapterPrincipal()), Cl.bool(true)],
      deployer,
    ),
    "set-dex-adapter",
  );
}

/** What the oracle says `sats` is worth, in micro-STX. */
export const quote = (sats: number, rate = RATE) => Math.floor((sats * rate) / 100_000_000);

export function swap(
  cycle: number,
  amountSats: number,
  minStxOut: number,
  sender = deployer,
  adapter = adapterPrincipal(),
  oracle = oraclePrincipal(),
) {
  return simnet.callPublicFn(
    MGR,
    "swap-rewards",
    [
      Cl.uint(cycle),
      Cl.principal(adapter),
      Cl.principal(oracle),
      Cl.uint(amountSats),
      Cl.uint(minStxOut),
    ],
    sender,
  );
}

export const distributeMany = (who: string[], cycle: number, sender = deployer) =>
  simnet.callPublicFn(
    MGR,
    "distribute-rewards-many",
    [Cl.list(who.map((w) => Cl.principal(w))), Cl.uint(cycle)],
    sender,
  );

export const distribute = (who: string, cycle: number, sender = deployer) =>
  simnet.callPublicFn(MGR, "distribute-rewards", [Cl.principal(who), Cl.uint(cycle)], sender);
