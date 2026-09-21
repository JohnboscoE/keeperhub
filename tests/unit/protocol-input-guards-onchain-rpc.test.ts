import { beforeEach, describe, expect, it, vi } from "vitest";

// Unlike protocol-input-guards-onchain.test.ts, readContractCore is NOT mocked
// here. Which provider the ownerOf read uses is decided inside it, from the
// _context the guard passes, so a test that mocks it can only see the guard
// forwarding its own input. This one lets the real readContractCore and the
// real RPC-preference lookup run, and asserts what reaches the provider
// factory.

vi.mock("server-only", () => ({}));

const EXECUTION_USER = "user_exec_42";

const { mockGetRpcProvider, mockResolveSignerForNode } = vi.hoisted(() => ({
  mockGetRpcProvider: vi.fn(),
  mockResolveSignerForNode: vi.fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    VALIDATION: "validation",
    NETWORK_RPC: "network_rpc",
  },
  logUserError: vi.fn(),
}));

// The only row getRpcPreferenceUserId reads: the execution's user.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ userId: EXECUTION_USER }]),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id", userId: "userId" },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  sql: () => ({}),
}));

vi.mock("@/lib/explorer", () => ({
  getAddressUrl: () => "",
}));

vi.mock("@/lib/rpc/network-utils", () => ({
  getChainIdFromNetwork: () => 1,
}));

vi.mock("@/lib/rpc/provider-factory", () => ({
  getRpcProvider: mockGetRpcProvider,
  isSolanaChain: () => false,
}));

vi.mock("@/lib/safe/signer-resolver", () => ({
  SIGNER_MODE: { EOA: "eoa", SAFE: "safe", SAFE_ROLE: "safe-role" },
  resolveSignerForNode: mockResolveSignerForNode,
}));

import { checkProtocolOnchainGuards } from "@/lib/protocol-input-guards-onchain";
import { registerProtocol } from "@/lib/protocol-registry";
import uniswapDef from "@/protocols/uniswap-v3";

registerProtocol(uniswapDef);

const increase = (executionId: string | undefined) =>
  checkProtocolOnchainGuards({
    protocolSlug: "uniswap",
    functionName: "increaseLiquidity",
    inputs: { tokenId: "180205" },
    network: "1",
    organizationId: "org_1",
    executionId,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSignerForNode.mockResolvedValue({
    kind: "eoa",
    ownerAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  });
  // Stop at provider selection: everything this file asserts has happened by
  // then, and a rejected provider is a read failure the guard passes on.
  mockGetRpcProvider.mockRejectedValue(new Error("stop after selection"));
});

describe("increase-liquidity ownership guard RPC selection", () => {
  // The workflow write resolves the execution's user and honours their RPC
  // preference. The guard's read has to land on the same provider, or it fails
  // open for exactly the users whose custom RPC exists because the default
  // does not work for them.
  it("reads through the execution user's RPC preference on the workflow path", async () => {
    await increase("exec_1");

    expect(mockGetRpcProvider).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 1, userId: EXECUTION_USER })
    );
  });

  // The direct-execute route has no execution yet when the guard runs, and its
  // write passes organizationId, which resolves the chain default. The guard
  // must land there too.
  it("uses the chain default when there is no execution", async () => {
    await increase(undefined);

    expect(mockGetRpcProvider).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 1, userId: undefined })
    );
  });
});
