import "server-only";

import { ErrorCategory, logSystemWarn } from "@/lib/logging";
import type { ProtocolInputGuardResult } from "@/lib/protocol-input-guards";
import { getProtocol, resolveContractAddress } from "@/lib/protocol-registry";
import { listOrgSafes } from "@/lib/safe/deployment";
import {
  resolveSignerForNode,
  SIGNER_MODE,
  type SignerMode,
} from "@/lib/safe/signer-resolver";
import { getErrorMessage } from "@/lib/utils";
import { readContractCore } from "@/plugins/web3/steps/read-contract-core";

/**
 * Guards that need a network round trip, kept apart from the cheap value
 * guards in protocol-input-guards.ts so the cheap ones can run before any I/O.
 *
 * Today there is one: Uniswap's `increaseLiquidity` is the only position
 * action with no ownership check. `decreaseLiquidity`, `collect` and `burn`
 * all carry `isAuthorizedForToken`, so a wrong token ID reverts on them. On
 * `increaseLiquidity` it succeeds: the tokens are deposited into whoever's
 * position the id names, the call reports a `liquidity` output, and the caller
 * has no claim on that NFT. The only thing that turns that silent loss into a
 * revert is reading the owner first.
 */

const OWNER_OF_ABI = JSON.stringify([
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
]);

const DIGITS = /^\d+$/;

type ProtocolOnchainGuardInput = {
  protocolSlug: string;
  functionName: string;
  /** Raw action inputs, keyed by input name. */
  inputs: Record<string, unknown>;
  network: string;
  organizationId: string | undefined;
  /**
   * The workflow execution this write belongs to, when there is one. RPC
   * preferences are resolved from the execution's user, so this is what lets
   * the ownerOf read use the same provider as the write it guards.
   */
  executionId?: string;
};

/**
 * The signer the write will use, resolved the way writeContractCore resolves
 * it. Returned whole rather than as one address because the guard needs both
 * the sender and the owner EOA behind it.
 *
 * Deliberately resolves under org policy with no `web3Connection`. Neither
 * write this guard covers honours that field - the direct-execute route records
 * a caller-supplied one as a rejected override rather than acting on it
 * (execution-service.ts), and protocolWriteStep leaves it out of the write's
 * input - so reading it here would let the guard compute a sender the write
 * never uses.
 */
async function resolveExecutingSigner(
  organizationId: string,
  chainId: number
): Promise<SignerMode> {
  return await resolveSignerForNode({
    organizationId,
    chainId,
    web3Connection: undefined,
    recordMetrics: false,
  });
}

/** The address that is msg.sender at the position manager for this mode. */
function senderOf(signerMode: SignerMode): string {
  // In safe and safe-role modes the Safe is msg.sender at the target, so it is
  // the Safe that transacts, not the owner EOA behind it.
  return signerMode.kind === SIGNER_MODE.EOA
    ? signerMode.ownerAddress
    : signerMode.safeAddress;
}

/**
 * Every address the organization itself controls on this chain: the owner EOA
 * behind the signer (returned in all three modes) and the org's Safes.
 *
 * This is deliberately not an approval check. `approve` and `setApprovalForAll`
 * are called by a position's owner naming whatever address they like, so a
 * stranger can approve this org's wallet on a position they keep. Reading the
 * approval would then answer "yes" for exactly the input the guard exists to
 * refuse - a tokenId the org does not control - while the owner keeps the
 * right to withdraw the deposit, revoke, or transfer the NFT away. Ownership
 * by an org address is the only answer that survives the owner acting against
 * us, and when it holds the deposit is recoverable with or without approvals.
 */
async function orgControlledAddresses(
  organizationId: string,
  chainId: number,
  signerMode: SignerMode
): Promise<Set<string>> {
  const addresses = new Set<string>([signerMode.ownerAddress.toLowerCase()]);
  for (const safe of await listOrgSafes(organizationId)) {
    if (safe.chainId === chainId) {
      addresses.add(safe.safeAddress.toLowerCase());
    }
  }
  return addresses;
}

export async function checkProtocolOnchainGuards(
  input: ProtocolOnchainGuardInput
): Promise<ProtocolInputGuardResult> {
  const isUniswapIncrease =
    input.protocolSlug === "uniswap" &&
    input.functionName === "increaseLiquidity";
  if (!isUniswapIncrease) {
    return { ok: true };
  }

  // Not `typeof raw === "string"`: a JSON body carries `"tokenId": 180205` as a
  // number, and the direct-execute route passes the body through untouched, so
  // narrowing to strings would skip the read for exactly the caller this guard
  // exists to stop. A template rendering to a native value lands the same way.
  const tokenId = String(input.inputs.tokenId ?? "").trim();
  // A malformed id is the encoder's to reject, with its own message.
  if (!DIGITS.test(tokenId)) {
    return { ok: true };
  }

  const protocol = getProtocol(input.protocolSlug);
  const contract = protocol?.contracts.positionManager;
  const contractAddress = contract
    ? resolveContractAddress(contract, input.network, undefined)
    : undefined;
  if (!(contractAddress && input.organizationId)) {
    // No registry address or no org context (direct tooling): nothing to
    // compare against. The cheap guards and the encoder still apply.
    return { ok: true };
  }

  const chainId = Number(input.network);
  if (!Number.isFinite(chainId)) {
    // Not a chain id the resolver can use; the encoder rejects it downstream.
    return { ok: true };
  }

  let signerMode: SignerMode;
  try {
    signerMode = await resolveExecutingSigner(input.organizationId, chainId);
  } catch (error) {
    // Not a pass. Failing to work out who signs is not evidence that the
    // position is owned, and swallowing it here would switch the guard off for
    // any input that makes signer resolution throw. The write resolves the
    // signer the same way, so it would fail too - this just says why first.
    logSystemWarn(
      ErrorCategory.CONFIGURATION,
      "[Protocol Guard] Could not resolve the signer for an ownership check",
      error,
      { protocol: input.protocolSlug, function: input.functionName }
    );
    return {
      ok: false,
      field: "tokenId",
      error: `Could not determine which wallet will send this transaction, so the position's ownership cannot be checked: ${getErrorMessage(error)}`,
    };
  }

  const sender = senderOf(signerMode);
  if (!sender) {
    return { ok: true };
  }

  const read = await readContractCore({
    contractAddress,
    network: input.network,
    abi: OWNER_OF_ABI,
    abiFunction: "ownerOf",
    functionArgs: JSON.stringify([tokenId]),
    failOnError: false,
    // Match the provider the write will use. Pass executionId and never
    // organizationId: readContractCore treats organizationId as "skip the
    // preference lookup", so adding it would force the chain default even
    // where the write honours a user's RPC. The three callers:
    //
    // - Workflow runs: executionId is a workflowExecutions row, so
    //   getRpcPreferenceUserId finds the user and the read and the write both
    //   use their preferred RPC.
    // - /api/execute/node: executionId is a directExecutions row. That lookup
    //   selects from workflowExecutions only, misses, and returns undefined,
    //   so the read uses the chain default.
    // - /api/execute/{protocol}/{action}: the guard runs before reservation
    //   with no executionId, and that route's write passes organizationId, so
    //   both use the chain default.
    _context: { executionId: input.executionId },
  });

  if (!read.success || read.error !== undefined || read.result === null) {
    // ownerOf reverts for an id that was never minted or has been burned,
    // which is itself a wrong id - but an RPC outage lands here too and the
    // two are not distinguishable from this result shape. Refusing on an
    // outage would break every scheduled compound, so this passes and leaves
    // the position manager to accept a deposit the tip warns about. Logged so
    // the skips are countable: this is the guard being off, silently, on the
    // one call that cannot be undone.
    logSystemWarn(
      ErrorCategory.NETWORK_RPC,
      "[Protocol Guard] Ownership check skipped: position owner unreadable",
      read.error ?? "no result",
      { protocol: input.protocolSlug, function: input.functionName }
    );
    return { ok: true };
  }

  // readContractCore runs results through structureAbiOutputs, which wraps a
  // single *named* output as { owner: value } - so the value is behind the
  // ABI's output name, not the result itself.
  const owner = String(
    (read.result as { owner?: unknown } | null)?.owner ?? ""
  ).trim();
  if (owner === "") {
    return { ok: true };
  }
  if (owner.toLowerCase() === sender.toLowerCase()) {
    return { ok: true };
  }

  // The sender is not the holder. That is still fine when the holder is an
  // address the org controls - the EOA holds the position and the Safe signs,
  // or a second Safe of the org holds it - because the org can withdraw the
  // deposit in every one of those arrangements. Anything else, including a
  // position whose holder has approved this wallet, is refused: see
  // orgControlledAddresses for why an approval proves nothing here. Only
  // reached on a mismatch, so the common path still costs one read.
  const orgAddresses = await orgControlledAddresses(
    input.organizationId,
    chainId,
    signerMode
  );
  if (orgAddresses.has(owner.toLowerCase())) {
    return { ok: true };
  }

  return {
    ok: false,
    field: "tokenId",
    error: `Position ${tokenId} belongs to ${owner}, which is not one of this organization's wallets (this step would send from ${sender}). Uniswap does not check ownership on increaseLiquidity, so adding liquidity to it would deposit your tokens into someone else's position with no way to withdraw them.`,
  };
}
