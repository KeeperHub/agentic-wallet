// Shared types across the package. Phase 34.
export type WalletConfig = {
  /** Turnkey sub-org ID returned by POST /api/agentic-wallet/provision */
  subOrgId: string;
  /** EVM-shared wallet address (same for Base chainId 8453 and Tempo chainId 4217) */
  walletAddress: `0x${string}`;
  /** 64-char lowercase hex HMAC secret, minted server-side at provision; never logged */
  hmacSecret: string;
};

export type HmacHeaders = {
  "X-KH-Sub-Org": string;
  "X-KH-Timestamp": string;
  "X-KH-Signature": string;
};

export type HookDecision = {
  decision: "allow" | "deny" | "ask";
  reason?: string;
};

export class KeeperHubError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "KeeperHubError";
    this.code = code;
  }
}

export class WalletConfigMissingError extends Error {
  constructor() {
    super(
      "Wallet config not found at ~/.keeperhub/wallet.json. Run `npx @keeperhub/wallet add` to provision."
    );
    this.name = "WalletConfigMissingError";
  }
}
