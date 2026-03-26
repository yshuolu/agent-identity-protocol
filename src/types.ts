/** Master identity reference — never leaves the identity service */
export interface MasterIdentity {
  mid: string;
  email: string;
  status: 'active' | 'suspended' | 'closed';
  max_scopes: string[];
  created_at: number;
}

/** AIP token payload claims */
export interface AgentTokenPayload {
  // Registered JWT claims
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;

  // AIP claims
  mid: string;
  aid: string;
  scopes: string[];
  budget?: { usd: number };
  bind?: {
    ip?: string | null;
    task?: string | null;
    parent_aid?: string | null;
  };
  delegation?: {
    allowed: boolean;
    max_depth: number;
  };
}

/** Request to mint a new agent token */
export interface MintRequest {
  scopes: string[];
  ttl: number;
  budget?: { usd: number };
  bind_ip?: string;
  bind_task?: string;
  delegation_allowed?: boolean;
}

/** Response from minting a token */
export interface MintResponse {
  token: string;
  aid: string;
  expires_at: number;
  refresh_token: string;
}

/** Revocation list entry */
export interface RevocationEntry {
  aid: string;
  revoked_at: number;
  reason: 'manual' | 'budget_exhausted' | 'mi_suspended' | 'security';
}

/** Revocation list */
export interface RevocationList {
  published_at: number;
  next_update: number;
  revoked: RevocationEntry[];
}

/** Billing report from a resource provider */
export interface BillingReport {
  mid: string;
  aid: string;
  service: string;
  action: string;
  cost: { usd: number };
  timestamp: number;
  request_id: string;
}

/** Token verification result */
export type VerifyResult =
  | { ok: true; payload: AgentTokenPayload }
  | { ok: false; error: string; message: string };
