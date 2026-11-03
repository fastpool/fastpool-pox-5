// `signer-manager-vault-stx-rewards`: the STX-rewards signer manager with the
// sBTC -> STX conversion delegated to a swap vault. Runs against
// `mock-swap-vault`, which keeps the real vault's fund / finish /
// emergency-recover contract and replaces trading with an owner-driven `sell`.
import { Cl, ClarityValue, cvToValue } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  currentCycle,
  fundRewards,
  num,
  POX5,
  registerSigner,
  SBTC,
} from "./helpers/rewards-fixture";

const MGR = "signer-manager-vault-stx-rewards";
const VAULT = "mock-swap-vault";
const VAULT2 = "mock-swap-vault-2";
const SWAP_VAULT_COOLDOWN = 4032;
const SWAP_WINDOW = 432;
const RECOVERY_DELAY = 432;
const POT = 50_000_000;
const RATE = 300; // micro-STX per sat the mock "sells" at

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const outsider = accounts.get("wallet_8")!;
const stakers = [1, 2, 3, 4, 5].map((i) => accounts.get(`wallet_${i}`)!);
const amounts = [100_000_000_000, 300_000_000_000, 55_000_000_000, 70_000_000_000, 120_000_000_000];
const totalShares = amounts.reduce((a, b) => a + b, 0);

const mgr = () => `${deployer}.${MGR}`;
const vaultP = (name = VAULT) => `${deployer}.${name}`;

const call = (fn: string, args: ClarityValue[], sender = deployer) =>
  simnet.callPublicFn(MGR, fn, args, sender);
const read = (fn: string, args: ClarityValue[] = []) =>
  simnet.callReadOnlyFn(MGR, fn, args, deployer).result;
const readNum = (fn: string, args: ClarityValue[] = []) => num(read(fn, args));
const poxNum = (fn: string, args: ClarityValue[]) =>
  num(simnet.callReadOnlyFn(POX5, fn, args, deployer).result);

const ok = (r: any, label: string) => {
  if (r.result.type !== "ok") throw new Error(`${label}: ${Cl.prettyPrint(r.result)}`);
  return r.result.value;
};
/** The `(ok uN)` of a call, as a number. */
const okNum = (r: any, label: string) => Number(ok(r, label).value);
const errCode = (r: any) => {
  expect(r.result.type, Cl.prettyPrint(r.result)).toBe("err");
  return Number(r.result.value.value);
};

const sbtcBalance = (who: string) =>
  Number(
    (simnet.callReadOnlyFn(`${SBTC}.sbtc-token`, "get-balance", [Cl.principal(who)], deployer)
      .result as any).value.value,
  );
const stxBalance = (who: string) => Number(simnet.getAssetsMap().get("STX")?.get(who) ?? 0n);

const settlement = (cycle: number) => {
  const t = cvToValue(read("get-swap-status", [Cl.uint(cycle)]), true) as Record<string, any>;
  return Object.fromEntries(
    Object.entries(t).map(([k, v]) => [k, typeof v.value === "boolean" ? v.value : Number(v.value)]),
  ) as Record<string, number>;
};
const rewards = (who: string, cycle: number) => {
  const t = cvToValue(read("get-staker-rewards", [Cl.principal(who), Cl.uint(cycle)]), true) as any;
  return { stxDue: Number(t["stx-due"].value), sbtcDue: Number(t["sbtc-due"].value) };
};

function expectInvariants() {
  for (const fn of [
    "invariant-stx-liability-is-covered",
    "invariant-sbtc-liability-is-covered",
    "invariant-fee-never-exceeds-cap",
    "invariant-cycle-accounting-is-consistent",
  ]) {
    expect(read(fn), fn).toStrictEqual(Cl.bool(true));
  }
}

// --- vault plumbing --------------------------------------------------------

const propose = (name = VAULT, sender = deployer) =>
  call("propose-swap-vault", [Cl.principal(vaultP(name))], sender);
const confirm = (name = VAULT, sender = deployer) =>
  call("confirm-swap-vault", [Cl.principal(vaultP(name))], sender);

/** Make `name` the active vault, through the full notice period. */
function activate(name = VAULT) {
  ok(propose(name), `propose ${name}`);
  simnet.mineEmptyBurnBlocks(SWAP_VAULT_COOLDOWN);
  ok(confirm(name), `confirm ${name}`);
}

const fund = (cycle: number, name = VAULT, sender = deployer) =>
  call("fund-swap-vault", [Cl.uint(cycle), Cl.principal(vaultP(name))], sender);
const finalize = (name = VAULT, sender = outsider) =>
  call("finalize-swap-vault", [Cl.principal(vaultP(name))], sender);
const recover = (name = VAULT, sender = outsider) =>
  call("recover-swap-vault", [Cl.principal(vaultP(name))], sender);
const vaultCall = (name: string, fn: string, args: ClarityValue[]) =>
  ok(simnet.callPublicFn(name, fn, args, deployer), `${name}.${fn}`);
/** The mock "sells" `sats` at RATE. */
const sell = (sats: number, name = VAULT) =>
  vaultCall(name, "sell", [Cl.uint(sats), Cl.uint(sats * RATE)]);

const distributeMany = (cycle: number, who = stakers, sender = outsider) =>
  call("distribute-rewards-many", [Cl.list(who.map((w) => Cl.principal(w))), Cl.uint(cycle)], sender);

// --- pox-5 plumbing --------------------------------------------------------

function advancePastCycle(cycle: number) {
  const target = poxNum("reward-cycle-to-burn-height", [Cl.uint(cycle + 1)]);
  simnet.mineEmptyBurnBlocks(Math.max(1, target - simnet.burnBlockHeight + 2));
}

function deliverPot(amount = POT) {
  fundRewards(stakers[0], amount);
  simnet.callPublicFn(POX5, "calculate-rewards", [Cl.list([])], deployer);
}

/** Activate the mock vault, stake everyone, run the first cycle out, claim. */
function setup({ numCycles = 2, fee = 0 } = {}) {
  if (fee > 0) ok(call("update-fees", [Cl.uint(fee)]), "update-fees");
  activate(VAULT); // also runs any queued fee increase into force
  registerSigner(deployer, MGR);

  const cycle = currentCycle(deployer);
  const startBurnHt = poxNum("reward-cycle-to-burn-height", [Cl.uint(cycle)]);
  stakers.forEach((who, i) =>
    ok(
      simnet.callPublicFn(
        POX5,
        "stake",
        [Cl.principal(mgr()), Cl.uint(amounts[i]), Cl.uint(numCycles), Cl.uint(startBurnHt), Cl.none()],
        who,
      ),
      `stake ${i}`,
    ),
  );
  const rewardCycle = cycle + 1;
  advancePastCycle(rewardCycle);
  deliverPot();
  const pot = okNum(call("claim-rewards", [Cl.uint(rewardCycle)]), "claim");
  expect(pot).toBeGreaterThan(0);
  return { rewardCycle, pot };
}

const share = (total: number, i: number) => Math.floor((total * amounts[i]) / totalShares);

// ---------------------------------------------------------------------------

describe("happy path", () => {
  it("funds the vault net of fees, books the STX, and pays everyone pro-rata", () => {
    const { rewardCycle, pot } = setup({ fee: 500 });
    expect(readNum("get-fee-bips-for-cycle", [Cl.uint(rewardCycle)])).toBe(500);

    const fee = Math.floor((pot * 500) / 10_000);
    const net = pot - fee;
    expect(okNum(fund(rewardCycle, VAULT, outsider), "fund")).toBe(net);
    expect(sbtcBalance(vaultP())).toBe(net);
    expect(readNum("get-earned-fees")).toBe(fee);
    expect(settlement(rewardCycle)["in-vault-sats"]).toBe(net);
    expectInvariants();

    sell(net);
    const res = ok(finalize(), "finalize") as any;
    expect(Number(res.value.stx.value)).toBe(net * RATE);
    expect(settlement(rewardCycle)["stx-out"]).toBe(net * RATE);
    expect(settlement(rewardCycle)["in-vault-sats"]).toBe(0);
    expect(read("get-vault-batch", [Cl.principal(vaultP())])).toStrictEqual(Cl.none());

    const before = stakers.map(stxBalance);
    ok(distributeMany(rewardCycle), "distribute");
    stakers.forEach((who, i) => {
      expect(stxBalance(who) - before[i]).toBe(share(net * RATE, i));
    });
    // Idempotent: a second run pays nothing more.
    const again = ok(distributeMany(rewardCycle), "distribute again") as any;
    expect(Number(again.value.paid.value)).toBe(0);
    expectInvariants();
  });

  it("refuses to distribute before anything is booked", () => {
    const { rewardCycle } = setup();
    ok(fund(rewardCycle), "fund");
    const r = call("distribute-rewards", [Cl.principal(stakers[0]), Cl.uint(rewardCycle)], outsider);
    expect(errCode(r)).toBe(1001);
  });

  it("keeps the vault's reserve back on finish, and books only what arrived", () => {
    const { rewardCycle, pot } = setup();
    vaultCall(VAULT, "set-reserve", [Cl.uint(1_000_000)]);
    ok(fund(rewardCycle), "fund");
    sell(pot);
    ok(finalize(), "finalize");
    expect(settlement(rewardCycle)["stx-out"]).toBe(pot * RATE - 1_000_000);
    expectInvariants();
  });
});

describe("funding", () => {
  it("only funds the active vault", () => {
    const { rewardCycle } = setup();
    expect(errCode(fund(rewardCycle, VAULT2))).toBe(1040); // ERR_NOT_ACTIVE_VAULT
  });

  it("refuses a second batch while the vault is busy", () => {
    const { rewardCycle } = setup();
    ok(fund(rewardCycle), "fund");
    expect(errCode(fund(rewardCycle))).toBe(1041); // ERR_VAULT_BUSY
  });

  it("refuses an empty batch", () => {
    const { rewardCycle, pot } = setup();
    ok(fund(rewardCycle), "fund");
    sell(pot);
    ok(finalize(), "finalize");
    expect(errCode(fund(rewardCycle))).toBe(1042); // ERR_NOTHING_TO_FUND
  });

  it("catches a vault that takes less than it was funded with", () => {
    const { rewardCycle } = setup();
    vaultCall(VAULT, "set-mode", [Cl.uint(1)]);
    expect(errCode(fund(rewardCycle))).toBe(1044); // ERR_VAULT_FUNDING_MISMATCH
  });

  it("refuses to fund after the window", () => {
    const { rewardCycle } = setup();
    simnet.mineEmptyBurnBlocks(SWAP_WINDOW + 1);
    expect(errCode(fund(rewardCycle))).toBe(1026); // ERR_SWAP_WINDOW_CLOSED
  });
});

describe("no stranded sBTC", () => {
  it("releases a never-funded pot as sBTC, fee taken once", () => {
    const { rewardCycle, pot } = setup({ fee: 300 });
    simnet.mineEmptyBurnBlocks(SWAP_WINDOW + 1);
    const fee = Math.floor((pot * 300) / 10_000);
    const before = stakers.map(sbtcBalance);
    ok(distributeMany(rewardCycle), "distribute");
    stakers.forEach((who, i) => expect(sbtcBalance(who) - before[i]).toBe(share(pot - fee, i)));
    expect(readNum("get-earned-fees")).toBe(fee);
    expect(settlement(rewardCycle)["released-sats"]).toBe(pot);
    // A second release finds nothing.
    expect(okNum(call("release-unfunded", [Cl.uint(rewardCycle)]), "release")).toBe(0);
    expectInvariants();
  });

  it("does not release while the window is open", () => {
    const { rewardCycle } = setup();
    expect(okNum(call("release-unfunded", [Cl.uint(rewardCycle)]), "release")).toBe(0);
    expect(settlement(rewardCycle)["released-sats"]).toBe(0);
  });

  it("recovers a partly sold batch and pays both legs", () => {
    const { rewardCycle, pot } = setup();
    ok(fund(rewardCycle), "fund");
    const sold = Math.floor(pot / 4);
    sell(sold);

    expect(errCode(recover())).toBe(16046); // the vault's own delay
    simnet.mineEmptyBurnBlocks(RECOVERY_DELAY);
    const res = ok(recover(), "recover") as any;
    expect(Number(res.value.stx.value)).toBe(sold * RATE);
    expect(Number(res.value.sbtc.value)).toBe(pot - sold);

    const stxBefore = stakers.map(stxBalance);
    const sbtcBefore = stakers.map(sbtcBalance);
    ok(distributeMany(rewardCycle), "distribute");
    stakers.forEach((who, i) => {
      expect(stxBalance(who) - stxBefore[i]).toBe(share(sold * RATE, i));
      expect(sbtcBalance(who) - sbtcBefore[i]).toBe(share(pot - sold, i));
    });
    expectInvariants();
  });

  it("credits what arrives, not what a vault reports", () => {
    const { rewardCycle, pot } = setup();
    ok(fund(rewardCycle), "fund");
    sell(pot);
    vaultCall(VAULT, "set-mode", [Cl.uint(2)]); // over-report
    ok(finalize(), "finalize");
    expect(settlement(rewardCycle)["stx-out"]).toBe(pot * RATE);
    expect(readNum("get-unpaid-stx")).toBe(pot * RATE);
    expectInvariants();
  });

  it("credits what arrives on recovery, not what a vault reports", () => {
    const { rewardCycle, pot } = setup();
    ok(fund(rewardCycle), "fund");
    vaultCall(VAULT, "set-mode", [Cl.uint(2)]);
    simnet.mineEmptyBurnBlocks(RECOVERY_DELAY);
    ok(recover(), "recover");
    expect(settlement(rewardCycle)["sbtc-out"]).toBe(pot);
    expect(settlement(rewardCycle)["stx-out"]).toBe(0);
    expectInvariants();
  });

  it("refuses to settle a vault it never funded", () => {
    setup();
    expect(errCode(finalize(VAULT2))).toBe(1043); // ERR_NO_VAULT_BATCH
    expect(errCode(recover(VAULT2))).toBe(1043);
  });

  it("lets finalize be retried after a failed finish", () => {
    const { rewardCycle, pot } = setup();
    ok(fund(rewardCycle), "fund");
    sell(pot);
    vaultCall(VAULT, "set-mode", [Cl.uint(3)]);
    expect(errCode(finalize())).toBe(16099);
    vaultCall(VAULT, "set-mode", [Cl.uint(0)]);
    // A failed finish changes nothing, so it can simply be retried.
    ok(finalize(), "finalize");
    expect(settlement(rewardCycle)["stx-out"]).toBe(pot * RATE);
  });
});

describe("vault rotation", () => {
  it("enforces the notice period and admin-only access", () => {
    setup();
    expect(errCode(propose(VAULT2, outsider))).toBe(1002);
    ok(propose(VAULT2), "propose");
    expect(errCode(confirm(VAULT2))).toBe(1048); // ERR_SWAP_VAULT_COOLDOWN
    simnet.mineEmptyBurnBlocks(SWAP_VAULT_COOLDOWN);
    expect(errCode(confirm(VAULT2, outsider))).toBe(1002);
    expect(errCode(confirm(VAULT))).toBe(1047); // not the proposed one
    ok(confirm(VAULT2), "confirm");
    expect(read("get-swap-vault")).toStrictEqual(Cl.principal(vaultP(VAULT2)));
  });

  it("refuses a vault bound to another pool, the active vault, or a busy vault", () => {
    setup();
    expect(errCode(propose(VAULT))).toBe(1045); // already active
    vaultCall(VAULT2, "set-reported-pool", [Cl.some(Cl.principal(outsider))]);
    expect(errCode(propose(VAULT2))).toBe(1045); // ERR_INVALID_SWAP_VAULT
    vaultCall(VAULT2, "set-reported-pool", [Cl.none()]);
    vaultCall(VAULT2, "set-jing-resting", [Cl.uint(1)]);
    expect(errCode(propose(VAULT2))).toBe(1046); // ERR_SWAP_VAULT_NOT_IDLE
  });

  it("re-checks the vault at confirm time", () => {
    setup();
    ok(propose(VAULT2), "propose");
    simnet.mineEmptyBurnBlocks(SWAP_VAULT_COOLDOWN);
    vaultCall(VAULT2, "set-jing-resting", [Cl.uint(1)]);
    expect(errCode(confirm(VAULT2))).toBe(1046);
  });

  it("replaces a vault that still holds a batch, which stays recoverable", () => {
    // Stake long enough to outlast the rotation's notice period (~4 cycles).
    const { rewardCycle, pot } = setup({ numCycles: 8 });
    ok(fund(rewardCycle), "fund");
    vaultCall(VAULT, "set-mode", [Cl.uint(3)]); // the old vault is broken

    activate(VAULT2);
    expect(read("get-swap-vault")).toStrictEqual(Cl.principal(vaultP(VAULT2)));

    // A later cycle goes to the new vault while the old batch is stuck.
    const next = currentCycle(deployer);
    expect(next).toBeLessThan(rewardCycle + 8);
    advancePastCycle(next);
    deliverPot();
    const pot2 = okNum(call("claim-rewards", [Cl.uint(next)]), "claim next");
    expect(pot2).toBeGreaterThan(0);
    ok(fund(next, VAULT2), "fund new vault");
    expect(errCode(fund(next, VAULT))).toBe(1040);

    // The old vault heals and its batch is recovered into its own cycle.
    vaultCall(VAULT, "set-mode", [Cl.uint(0)]);
    ok(recover(VAULT), "recover old");
    expect(settlement(rewardCycle)["sbtc-out"]).toBe(pot);
    expect(settlement(next)["sbtc-out"]).toBe(0);
    expectInvariants();
  });
});

describe("vault settings", () => {
  const set = (fn: string, v: number, sender = deployer, name = VAULT) =>
    call(fn, [Cl.uint(v), Cl.principal(vaultP(name))], sender);
  const lastCall = () => cvToValue(simnet.callReadOnlyFn(VAULT, "get-last-call", [], deployer).result, true) as any;

  it("bounds the price-protection settings tighter than the vault", () => {
    setup();
    expect(errCode(set("set-vault-slippage-bps", 301))).toBe(1049);
    ok(set("set-vault-slippage-bps", 300), "slippage");
    expect(lastCall().name.value).toBe("set-slippage-bps");
    expect(Number(lastCall().value.value)).toBe(300);

    expect(errCode(set("set-vault-leeway-bps", 501))).toBe(1049);
    ok(set("set-vault-leeway-bps", 500), "leeway");
    expect(errCode(set("set-vault-no-pyth-slippage-bps", 1001))).toBe(1049);
    ok(set("set-vault-no-pyth-slippage-bps", 1000), "no-pyth");
    expect(errCode(set("set-vault-dia-band-bps", 0))).toBe(1049);
    expect(errCode(set("set-vault-dia-band-bps", 1001))).toBe(1049);
    ok(set("set-vault-dia-band-bps", 1000), "dia-band");
  });

  it("is admin-only and active-vault-only", () => {
    setup();
    expect(errCode(set("set-vault-slippage-bps", 100, outsider))).toBe(1002);
    expect(errCode(set("set-vault-slippage-bps", 100, deployer, VAULT2))).toBe(1040);
    ok(set("set-vault-max-chunk-sats", 123), "chunk");
    expect(Number(lastCall().value.value)).toBe(123);
  });
});

describe("operator trades", () => {
  const take = (sender: string, name = VAULT) =>
    call("jing-take", [Cl.uint(1000), Cl.bufferFromHex("00"), Cl.principal(vaultP(name))], sender);

  it("lets only the operator trade, and only on a known vault", () => {
    setup();
    ok(call("set-operator", [Cl.principal(stakers[4])]), "set-operator");
    expect(errCode(take(outsider))).toBe(1020);
    expect(errCode(take(deployer))).toBe(1020); // admins are not the operator
    ok(take(stakers[4]), "jing-take");
    expect(errCode(take(stakers[4], VAULT2))).toBe(1040);
    ok(
      call(
        "router-swap-split-dia",
        [Cl.uint(10), Cl.uint(10), Cl.uint(0), Cl.uint(0), Cl.principal(vaultP())],
        stakers[4],
      ),
      "router-swap-split-dia",
    );
  });
});

describe("fees and sweeps", () => {
  it("caps the fee at 5%", () => {
    expect(errCode(call("update-fees", [Cl.uint(501)]))).toBe(1005);
    ok(call("update-fees", [Cl.uint(500)]), "500");
  });

  it("sweeps only sBTC and STX owed to nobody", () => {
    const { rewardCycle, pot } = setup({ fee: 100 });
    ok(fund(rewardCycle), "fund");
    sell(Math.floor(pot / 2));
    simnet.mineEmptyBurnBlocks(RECOVERY_DELAY);
    ok(recover(), "recover");

    expect(errCode(call("sweep-sbtc-dust", [Cl.principal(deployer)]))).toBe(1033);
    expect(errCode(call("sweep-stx-dust", [Cl.principal(deployer)]))).toBe(1033);

    ok(
      simnet.callPublicFn(
        `${SBTC}.sbtc-token`,
        "transfer",
        [Cl.uint(777), Cl.principal(deployer), Cl.principal(mgr()), Cl.none()],
        deployer,
      ),
      "stray sbtc",
    );
    ok(simnet.transferSTX(555, mgr(), deployer), "stray stx");
    expect(okNum(call("sweep-sbtc-dust", [Cl.principal(deployer)]), "sweep sbtc")).toBe(777);
    expect(okNum(call("sweep-stx-dust", [Cl.principal(deployer)]), "sweep stx")).toBe(555);

    const fee = Math.floor((pot * 100) / 10_000);
    expect(errCode(call("withdraw-fees", [Cl.uint(fee + 1), Cl.principal(deployer)]))).toBe(1007);
    ok(call("withdraw-fees", [Cl.uint(fee), Cl.principal(deployer)]), "withdraw");
    ok(distributeMany(rewardCycle), "distribute");
    expectInvariants();
  });
});
