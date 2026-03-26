import * as jose from 'jose';
import { randomBytes } from 'node:crypto';
import type { AgentTokenPayload, MintRequest, MintResponse, VerifyResult } from './types.js';

/**
 * Generate an Ed25519 key pair for the identity service.
 */
export async function generateKeyPair() {
  return jose.generateKeyPair('EdDSA', { crv: 'Ed25519' });
}

/**
 * Export the public key as a JWK for the JWKS endpoint.
 */
export async function exportPublicJWK(publicKey: jose.KeyLike, kid: string) {
  const jwk = await jose.exportJWK(publicKey);
  return { ...jwk, kid, use: 'sig' };
}

/**
 * Generate a unique agent ID.
 */
function generateAgentId(): string {
  return `agt_${randomBytes(8).toString('hex')}`;
}

/**
 * Generate a unique token ID.
 */
function generateTokenId(): string {
  return `tok_${randomBytes(8).toString('hex')}`;
}

/**
 * Generate an opaque refresh token.
 */
function generateRefreshToken(): string {
  return `rft_${randomBytes(32).toString('hex')}`;
}

/**
 * Mint a new AIP agent token.
 */
export async function mintToken(
  privateKey: jose.KeyLike,
  kid: string,
  issuer: string,
  mid: string,
  request: MintRequest
): Promise<MintResponse> {
  const aid = generateAgentId();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + request.ttl;

  const payload: Omit<AgentTokenPayload, 'iss' | 'sub' | 'aud' | 'iat' | 'exp' | 'jti'> = {
    mid,
    aid,
  };

  if (request.budget) {
    (payload as any).budget = request.budget;
  }

  if (request.bind_ip || request.bind_task) {
    (payload as any).bind = {
      ip: request.bind_ip ?? null,
      task: request.bind_task ?? null,
      parent_aid: null,
    };
  }

  if (request.delegation_allowed) {
    (payload as any).delegation = {
      allowed: true,
      max_depth: 3,
    };
  }

  const jti = generateTokenId();

  const token = await new jose.SignJWT(payload as unknown as jose.JWTPayload)
    .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid })
    .setIssuer(issuer)
    .setSubject(aid)
    .setAudience('*')
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(privateKey);

  return {
    token,
    aid,
    expires_at: exp,
    refresh_token: generateRefreshToken(),
  };
}

/**
 * Verify an AIP agent token.
 *
 * Uses the JWKS keyset for signature verification.
 * Returns the validated payload or an error.
 */
export async function verifyToken(
  token: string,
  jwks: jose.FlattenedJWSInput | jose.GetKeyFunction<jose.JWSHeaderParameters, jose.FlattenedJWSInput>,
  options?: {
    audience?: string;
    sourceIp?: string;
    taskId?: string;
    revokedAids?: Set<string>;
  }
): Promise<VerifyResult> {
  try {
    const { payload } = await jose.jwtVerify(token, jwks as any, {
      algorithms: ['EdDSA'],
      audience: options?.audience,
    });

    const claims = payload as unknown as AgentTokenPayload;

    // Check revocation
    if (options?.revokedAids?.has(claims.aid)) {
      return { ok: false, error: 'aip_token_revoked', message: 'Agent token has been revoked' };
    }

    // Check IP binding
    if (claims.bind?.ip && options?.sourceIp) {
      if (claims.bind.ip !== options.sourceIp) {
        return { ok: false, error: 'aip_ip_mismatch', message: 'Source IP does not match token binding' };
      }
    }

    // Check task binding
    if (claims.bind?.task && options?.taskId) {
      if (claims.bind.task !== options.taskId) {
        return { ok: false, error: 'aip_task_mismatch', message: 'Task ID does not match token binding' };
      }
    }

    return { ok: true, payload: claims };
  } catch (err) {
    if (err instanceof jose.errors.JWTExpired) {
      return { ok: false, error: 'aip_token_expired', message: 'Agent token has expired' };
    }
    if (err instanceof jose.errors.JWSSignatureVerificationFailed) {
      return { ok: false, error: 'aip_token_invalid', message: 'Invalid token signature' };
    }
    return {
      ok: false,
      error: 'aip_token_invalid',
      message: err instanceof Error ? err.message : 'Token verification failed',
    };
  }
}