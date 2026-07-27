import { Cl } from "@stacks/transactions";
import { describe, expect, it } from "vitest";

const accounts = simnet.getAccounts();
const caller = accounts.get("wallet_1")!;
const staker2 = accounts.get("wallet_2")!;
const staker3 = accounts.get("wallet_3")!;

const emptySummary = Cl.tuple({
    claimed: Cl.uint(0),
    "total-earned": Cl.uint(0),
    "total-fees": Cl.uint(0),
});

describe("fastpool-signer-manager", () => {
    it("claim-staker-rewards-many returns an empty summary when no stakers are provided", () => {
        const { result } = simnet.callPublicFn(
            "fastpool-signer-manager",
            "claim-staker-rewards-many",
            [Cl.list([]), Cl.uint(1), Cl.none()],
            caller,
        );

        expect(result).toBeOk(emptySummary);
    });

    it("claim-staker-rewards-many skips stakers with nothing to claim", () => {
        const { result } = simnet.callPublicFn(
            "fastpool-signer-manager",
            "claim-staker-rewards-many",
            [Cl.list([Cl.principal(staker2), Cl.principal(staker3)]), Cl.uint(1), Cl.none()],
            caller,
        );

        expect(result).toBeOk(emptySummary);
    });

    it("claim-staker-rewards still errors for a single staker with nothing to claim", () => {
        const { result } = simnet.callPublicFn(
            "fastpool-signer-manager",
            "claim-staker-rewards",
            [Cl.principal(staker2), Cl.uint(1), Cl.none()],
            caller,
        );

        expect(result).toBeErr(Cl.uint(1001));
    });
});
