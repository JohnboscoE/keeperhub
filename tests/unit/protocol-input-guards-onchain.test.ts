import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// vi.mock factories are hoisted above const declarations, and these run while
// the module under test is imported, so the fns must be hoisted with them.
const { mockReadContractCore, mockResolveSignerForNode } = vi.hoisted(() => ({
  mockReadContractCore: vi.fn(),
  mockResolveSignerForNode: vi.fn(),
}));

vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: mockReadContractCore,
}));
vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
  resolveSignerForNode: mockResolveSignerForNode,
}));

import { checkProtocolOnchainGuards } from "@/lib/protocol-input-guards-onchain";
import { registerProtocol } from "@/lib/protocol-registry";
import uniswapDef from "@/protocols/uniswap-v3";

const WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SAFE = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x6d64492e2b90f25F8Db3033942560377E166AB99";

registerProtocol(uniswapDef);

const increase = (inputs: Record<string, unknown>, organizationId = "org_1") =>
  checkProtocolOnchainGuards({
    protocolSlug: "uniswap",
    functionName: "increaseLiquidity",
    inputs,
    network: "1",
    organizationId,
  });

const ownerIs = (owner: string) => {
  mockReadContractCore.mockResolvedValue({
    success: true,
    result: owner,
    addressLink: "",
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSignerForNode.mockResolvedValue({
    kind: "eoa",
    ownerAddress: WALLET,
  });
});

// increaseLiquidity is the only position function Uniswap does not gate on
// ownership, so a wrong id funds a stranger's position and reports success.
// Reading the owner first is the only thing that turns that into a revert.
describe("uniswap increase-liquidity ownership guard", () => {
  it("refuses a position owned by someone else", async () => {
    ownerIs(STRANGER);

    const result = await increase({ tokenId: "180205" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("tokenId");
      expect(result.error).toContain(STRANGER);
      expect(result.error).toContain(WALLET);
    }
  });

  it("allows a position the workflow wallet owns", async () => {
    ownerIs(WALLET);

    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
  });

  it("compares case-insensitively", async () => {
    ownerIs(WALLET.toLowerCase());

    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
  });

  // In safe mode the Safe is msg.sender at the position manager, so the Safe
  // must hold the NFT - not the owner EOA behind it.
  it("expects the Safe to own the position in safe mode", async () => {
    mockResolveSignerForNode.mockResolvedValue({
      kind: "safe",
      ownerAddress: WALLET,
      safeAddress: SAFE,
      safeWalletId: "sw_1",
    });
    ownerIs(SAFE);
    expect((await increase({ tokenId: "180205" })).ok).toBe(true);

    ownerIs(WALLET);
    expect((await increase({ tokenId: "180205" })).ok).toBe(false);
  });

  // A revert for a burned id and an RPC outage arrive in the same shape, and
  // refusing on an outage would break every scheduled compound.
  it("passes when the owner cannot be read", async () => {
    mockReadContractCore.mockResolvedValue({
      success: false,
      error: "call reverted",
      result: null,
      addressLink: "",
    });

    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
  });

  it("does not call the chain for other functions, malformed ids, or no org", async () => {
    ownerIs(STRANGER);

    expect(
      (
        await checkProtocolOnchainGuards({
          protocolSlug: "uniswap",
          functionName: "collect",
          inputs: { tokenId: "180205" },
          network: "1",
          organizationId: "org_1",
        })
      ).ok
    ).toBe(true);
    expect((await increase({ tokenId: "not-a-number" })).ok).toBe(true);
    // Passed directly: an explicit `undefined` argument would still take the
    // helper's default, which is the opposite of what this case checks.
    expect(
      (
        await checkProtocolOnchainGuards({
          protocolSlug: "uniswap",
          functionName: "increaseLiquidity",
          inputs: { tokenId: "180205" },
          network: "1",
          organizationId: undefined,
        })
      ).ok
    ).toBe(true);
    expect(mockReadContractCore).not.toHaveBeenCalled();
  });
});
