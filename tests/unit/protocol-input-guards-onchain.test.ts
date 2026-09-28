import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// vi.mock factories are hoisted above const declarations, and these run while
// the module under test is imported, so the fns must be hoisted with them.
const { mockListOrgSafes, mockReadContractCore, mockResolveSignerForNode } =
  vi.hoisted(() => ({
    mockListOrgSafes: vi.fn(),
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
vi.mock("@/lib/safe/deployment", () => ({
  listOrgSafes: mockListOrgSafes,
}));

import { checkProtocolOnchainGuards } from "@/lib/protocol-input-guards-onchain";
import { registerProtocol } from "@/lib/protocol-registry";
import { structureAbiOutputs } from "@/plugins/web3/steps/structure-abi-result";
import uniswapDef from "@/protocols/uniswap-v3";

const WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SAFE = "0x1111111111111111111111111111111111111111";
// Synthetic: this only has to be an address the wallet does not control.
const STRANGER = "0x00000000000000000000000000000000000000a2";

registerProtocol(uniswapDef);

const increase = (inputs: Record<string, unknown>, organizationId = "org_1") =>
  checkProtocolOnchainGuards({
    protocolSlug: "uniswap",
    functionName: "increaseLiquidity",
    inputs,
    network: "1",
    organizationId,
  });

// Built with the real structureAbiOutputs rather than by hand: readContractCore
// runs every result through it, and a single *named* output comes back as
// { owner: value }. A hand-written bare string here is what let a guard that
// compared "[object Object]" to an address pass its own tests.
const ownerIs = (owner: string) => {
  mockReadContractCore.mockResolvedValue({
    success: true,
    result: structureAbiOutputs([owner], [{ name: "owner", type: "address" }]),
    addressLink: "",
  });
};

const orgSafesOnChain1 = (...safeAddresses: string[]) => {
  mockListOrgSafes.mockResolvedValue(
    safeAddresses.map((safeAddress, index) => ({
      chainId: 1,
      id: `sw_${index}`,
      organizationId: "org_1",
      safeAddress,
    }))
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSignerForNode.mockResolvedValue({
    kind: "eoa",
    ownerAddress: WALLET,
  });
  mockListOrgSafes.mockResolvedValue([]);
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

  it("returns the owner behind the ABI output name, not the result object", async () => {
    ownerIs(WALLET);

    // Guards the exact regression: if the guard read `result` instead of
    // `result.owner`, this comparison would stringify an object and refuse
    // every call, valid ones included.
    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
    ownerIs(STRANGER);
    expect((await increase({ tokenId: "180205" })).ok).toBe(false);
  });

  // A JSON body carries "tokenId": 180205 as a number, and the direct-execute
  // route passes the body through untouched.
  it("reads the owner for a numeric token id too", async () => {
    ownerIs(STRANGER);

    const result = await increase({ tokenId: 180_205 });

    expect(mockReadContractCore).toHaveBeenCalled();
    expect(result.ok).toBe(false);
  });

  it("allows a position the workflow wallet owns", async () => {
    ownerIs(WALLET);

    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
  });

  it("compares case-insensitively", async () => {
    ownerIs(WALLET.toLowerCase());

    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
  });

  // In safe mode the Safe is msg.sender at the position manager, so a position
  // it holds needs no further check. A stranger's still fails - and note the
  // EOA behind the Safe is a separate, allowed case, pinned further down.
  it("accepts the signing Safe as holder in safe mode", async () => {
    mockResolveSignerForNode.mockResolvedValue({
      kind: "safe",
      ownerAddress: WALLET,
      safeAddress: SAFE,
      safeWalletId: "sw_1",
    });
    ownerIs(SAFE);
    expect((await increase({ tokenId: "180205" })).ok).toBe(true);

    ownerIs(STRANGER);
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

  // An approval is granted by the holder to an address of their choosing, so
  // a stranger can approve this org's wallet on a position they keep. Deciding
  // on the approval would pass exactly the input this guard exists to refuse:
  // the deposit lands in their position and they withdraw it, and they can
  // revoke or transfer the NFT whenever they like. Only the holder's identity
  // survives the holder acting against us.
  it("refuses a stranger's position even when it approves this wallet", async () => {
    ownerIs(STRANGER);

    const result = await increase({ tokenId: "180205" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not one of this organization's wallets");
    }
  });

  // The arrangement that motivated looking past owner equality: the EOA holds
  // the position and the Safe signs. The org controls both, so the deposit is
  // recoverable and this must not be refused.
  it("allows a position held by the org EOA while the Safe signs", async () => {
    mockResolveSignerForNode.mockResolvedValue({
      kind: "safe",
      ownerAddress: WALLET,
      safeAddress: SAFE,
      safeWalletId: "sw_1",
    });
    ownerIs(WALLET);

    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
  });

  it("allows a position held by another Safe of the same org", async () => {
    const OTHER_SAFE = "0x2222222222222222222222222222222222222222";
    orgSafesOnChain1(SAFE, OTHER_SAFE);
    ownerIs(OTHER_SAFE);

    expect((await increase({ tokenId: "180205" })).ok).toBe(true);
  });

  // Safes are per chain, so one on another chain says nothing about who holds
  // this position here.
  it("ignores an org Safe registered on a different chain", async () => {
    mockListOrgSafes.mockResolvedValue([
      {
        chainId: 8453,
        id: "sw_base",
        organizationId: "org_1",
        safeAddress: STRANGER,
      },
    ]);
    ownerIs(STRANGER);

    expect((await increase({ tokenId: "180205" })).ok).toBe(false);
  });

  // Previously a throw here returned ok, so anything that made signer
  // resolution fail switched the guard off. Failing to work out who signs is
  // not evidence that the position is owned. The error is one org-policy
  // resolution can actually raise now that no connection value reaches it.
  it("refuses when the signer cannot be resolved", async () => {
    ownerIs(WALLET);
    mockResolveSignerForNode.mockRejectedValue(
      new Error("No organization wallet found for organization org_1")
    );

    const result = await increase({ tokenId: "180205" });

    expect(result.ok).toBe(false);
    expect(mockReadContractCore).not.toHaveBeenCalled();
  });

  // Neither write honours a caller-supplied web3Connection - the direct route
  // records it as a rejected override and protocolWriteStep leaves it out of
  // the write - so the guard must resolve under org policy or it would compute
  // a sender the write never uses.
  it("resolves the signer under org policy, never a supplied connection", async () => {
    ownerIs(WALLET);

    await increase({ tokenId: "180205", web3Connection: "eoa" });

    expect(mockResolveSignerForNode).toHaveBeenCalledWith(
      expect.objectContaining({ web3Connection: undefined })
    );
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
