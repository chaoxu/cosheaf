import { describe, expect, it } from "vitest";
import { statusExitOk } from "./coflat-status.mjs";

const baseStatus = {
  expectedCoflatRef: "pin",
  localCoflatHead: "newer-local",
  localCoflatMatchesPin: false,
  lockfileCoflatHash: "lock-hash",
  pinDrift: [],
  localCosheafHead: "cosheaf-sha",
};

describe("coflat status exit decision", () => {
  it("lets prod status pass when production matches even if local Coflat is not pinned", () => {
    expect(statusExitOk({
      ...baseStatus,
      deployedCosheafSha: "cosheaf-sha",
      deployedCoflatRef: "pin",
      deployedCosheafMatchesLocal: true,
      deployedCoflatMatchesPin: true,
    }, { prod: true })).toBe(true);
  });

  it("keeps non-prod status strict about local Coflat mismatch", () => {
    expect(statusExitOk(baseStatus)).toBe(false);
  });

  it("fails prod status when the deployed app is behind local HEAD", () => {
    expect(statusExitOk({
      ...baseStatus,
      deployedCosheafSha: "older-sha",
      deployedCoflatRef: "pin",
      deployedCosheafMatchesLocal: false,
      deployedCoflatMatchesPin: true,
    }, { prod: true })).toBe(false);
  });

  it("fails prod status when deployed Coflat does not match the pin", () => {
    expect(statusExitOk({
      ...baseStatus,
      deployedCosheafSha: "cosheaf-sha",
      deployedCoflatRef: "older-coflat",
      deployedCosheafMatchesLocal: true,
      deployedCoflatMatchesPin: false,
    }, { prod: true })).toBe(false);
  });

  it("fails prod status when documented Coflat pins drift", () => {
    expect(statusExitOk({
      ...baseStatus,
      pinDrift: [{ file: "AGENTS.md", found: "older-coflat" }],
      deployedCosheafSha: "cosheaf-sha",
      deployedCoflatRef: "pin",
      deployedCosheafMatchesLocal: true,
      deployedCoflatMatchesPin: true,
    }, { prod: true })).toBe(false);
  });
});
