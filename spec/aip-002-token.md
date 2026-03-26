# AIP-002: Token Specification

**Status:** Draft
**Version:** 0.1.0
**Authors:** AIP Contributors

---

## Abstract

This document specifies the format, signing, and verification of AIP Agent Tokens. Tokens are encoded as JSON Web Tokens (JWT) per RFC 7519, signed with EdDSA (Ed25519) per RFC 8037.

---

## 1. Token Format

AIP tokens are JWTs with three base64url-encoded segments: `header.payload.signature`.

### 1.1 Header

```json
{
  "alg": "EdDSA",
  "typ": "JWT",
  "kid": "is_key_2024_03"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `alg` | string | Yes | MUST be `"EdDSA"` |
| `typ` | string | Yes | MUST be `"JWT"` |
| `kid` | string | Yes | Key ID referencing the Identity Service's signing key |

Implementations MUST reject tokens with `alg` values other than `"EdDSA"`. This eliminates algorithm confusion attacks (CVE-2015-9235 and similar).

### 1.2 Payload (Claims)

```json
{
  "iss": "https://identity.example.com",
  "sub": "agt_7f3k9m2x",
  "aud": "*",
  "iat": 1710000000,
  "exp": 1710007200,
  "jti": "tok_8a2b3c4d",
  "mid": "master_id_abc123",
  "aid": "agt_7f3k9m2x",
  "budget": {
    "usd": 5.00
  },
  "bind": {
    "ip": null,
    "task": "task_xyz",
    "parent_aid": null
  },
  "delegation": {
    "allowed": false,
    "max_depth": 0
  }
}
```

#### Registered Claims (RFC 7519)

| Claim | Type | Required | Description |
|-------|------|----------|-------------|
| `iss` | string | Yes | Identity service URL |
| `sub` | string | Yes | Subject — the agent ID (`aid`) |
| `aud` | string | No | Audience — specific RP domain or `"*"` for any |
| `iat` | integer | Yes | Issued-at timestamp (Unix seconds) |
| `exp` | integer | Yes | Expiration timestamp (Unix seconds) |
| `jti` | string | Yes | Unique token ID for replay detection |

#### AIP Claims

| Claim | Type | Required | Description |
|-------|------|----------|-------------|
| `mid` | string | Yes | Master identity ID |
| `aid` | string | Yes | Agent instance ID (same as `sub`) |
| `budget` | object | No | Spend cap: `{ "usd": <number> }` |
| `bind.ip` | string | No | Lock to source IP or CIDR |
| `bind.task` | string | No | Lock to a specific task ID |
| `bind.parent_aid` | string | No | Parent agent ID (for delegated tokens) |
| `delegation.allowed` | boolean | No | Whether this agent can mint sub-tokens |
| `delegation.max_depth` | integer | No | Maximum remaining delegation depth |

### 1.3 Signature

The signature is computed over `base64url(header) + "." + base64url(payload)` using Ed25519 with the Identity Service's private key.

```
signature = Ed25519.sign(
  privateKey,
  ASCII(base64url(header) + "." + base64url(payload))
)
```

The signature is 64 bytes, base64url-encoded in the JWT.

---

## 2. Signing

### 2.1 Key Generation

The identity service generates an Ed25519 key pair:

```
privateKey: 32 bytes (kept secret, HSM-backed recommended)
publicKey:  32 bytes (published at /v1/keys)
```

### 2.2 Key Publication (JWKS)

The Identity Service publishes its public key(s) in JWKS format at `GET /v1/keys`:

```json
{
  "keys": [
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "kid": "is_key_2024_03",
      "x": "<base64url-encoded 32-byte public key>",
      "use": "sig"
    }
  ]
}
```

### 2.3 Key Rotation

When rotating keys:

1. Generate new key pair with new `kid`
2. Add new key to JWKS endpoint (both old and new are available)
3. Start signing new tokens with new key
4. After grace period (>= maximum token TTL), remove old key from JWKS
5. RPs cache JWKS with a TTL of 1 hour (recommended)

---

## 3. Verification

Resource providers verify tokens with this algorithm:

```
function verify(token: string, jwks: JWKS): Result {
  // 1. Decode
  [headerB64, payloadB64, sigB64] = token.split(".")
  header = JSON.parse(base64url.decode(headerB64))
  payload = JSON.parse(base64url.decode(payloadB64))
  signature = base64url.decode(sigB64)

  // 2. Algorithm check — MUST reject non-EdDSA
  if header.alg != "EdDSA":
    return Error("unsupported_algorithm")

  // 3. Find key
  key = jwks.find(k => k.kid == header.kid)
  if !key:
    return Error("unknown_key")

  // 4. Verify signature
  message = ASCII(headerB64 + "." + payloadB64)
  if !Ed25519.verify(key.publicKey, message, signature):
    return Error("invalid_signature")

  // 5. Check expiry
  if payload.exp < now():
    return Error("token_expired")

  // 6. Check not-before (if present)
  if payload.iat > now() + CLOCK_SKEW_TOLERANCE:
    return Error("token_not_yet_valid")

  // 7. Check audience (if restricted)
  if payload.aud != "*" and payload.aud != self.domain:
    return Error("audience_mismatch")

  // 8. Return validated claims
  return Ok(payload)
}
```

### 3.1 Clock Skew

Implementations SHOULD allow a clock skew tolerance of up to 30 seconds for `iat` and `exp` checks.

### 3.2 Binding Verification

If `bind.ip` is set, the RP MUST verify the request's source IP matches the bound IP or CIDR range.

If `bind.task` is set, the RP MUST verify the `X-AIP-Task` request header matches `bind.task`.

---

## 4. Token Lifecycle

```
                    ┌─────────┐
                    │  MINT   │
                    └────┬────┘
                         │
                    ┌────▼────┐
              ┌─────│  ACTIVE  │─────┐
              │     └────┬────┘     │
              │          │          │
         ┌────▼────┐ ┌──▼───┐ ┌───▼────┐
         │ REFRESH │ │EXPIRE│ │ REVOKE │
         └────┬────┘ └──────┘ └────────┘
              │
         ┌────▼────┐
         │  ACTIVE  │  (new token, new jti, same aid)
         └─────────┘
```

- **MINT:** Identity Service creates token, returns JWT + refresh token
- **ACTIVE:** Agent uses token for resource access
- **REFRESH:** Agent exchanges refresh token for new JWT (same `aid`, new `jti` and `exp`)
- **EXPIRE:** Token TTL reached, agent must refresh or stop
- **REVOKE:** Human or Identity Service revokes token, refresh denied

---

## 5. Token Size

Approximate sizes:

| Component | Size |
|-----------|------|
| Header (base64url) | ~60 bytes |
| Payload (base64url) | ~300-500 bytes |
| Signature (base64url) | ~86 bytes |
| Separators | 2 bytes |
| **Total** | **~450-650 bytes** |

This is significantly smaller than equivalent RSA-signed JWTs (RSA-256 signature alone is 342 base64url bytes).

---

## 6. Implementation Requirements

### 6.1 MUST
- Use `EdDSA` as the sole signing algorithm
- Reject tokens with `alg` != `"EdDSA"`
- Validate `exp` on every token use
- Include `kid` in token header
- Include `jti` for replay detection

### 6.2 SHOULD
- Cache JWKS with 1-hour TTL
- Allow 30-second clock skew tolerance
- Support `aud` claim for RP-specific tokens
- Track `jti` values within token TTL window for replay detection

### 6.3 MAY
- Support compressed payloads for bandwidth-constrained environments
- Include additional custom claims in the payload
- Implement token introspection endpoint for real-time validation

---

## 7. Security Considerations

### 7.1 Algorithm Pinning
By mandating `EdDSA` only, AIP avoids the class of JWT vulnerabilities related to algorithm switching (e.g., `"alg": "none"`, RSA/HMAC confusion). Implementations MUST NOT support algorithm negotiation.

### 7.2 Key Confusion
Ed25519 uses distinct key types from RSA/ECDSA, making cross-algorithm key confusion impossible.

### 7.3 Token Storage
Agents SHOULD store tokens in memory only, never persisted to disk. If persistence is required, tokens MUST be encrypted at rest.

### 7.4 Transport Security
Tokens MUST only be transmitted over TLS 1.2+. The `Authorization: Agent <token>` header MUST NOT be sent over unencrypted connections.
