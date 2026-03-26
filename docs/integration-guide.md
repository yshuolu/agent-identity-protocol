# Resource Provider Integration Guide

This guide explains how to integrate your service with the Agent Identity Protocol (AIP) so that AI agents can authenticate and consume your API using AIP tokens.

---

## Overview

Integrating with AIP means your service can:

- Accept requests from any AIP-authenticated agent
- Verify identity offline (no per-request call to the identity service)
- Bill usage back to the agent's master identity
- Respect revocation

The integration has 4 steps:

1. Register with the identity service
2. Cache the Identity Service's public keys
3. Accept and verify `Authorization: Agent <token>` headers
4. Report usage for billing

---

## Step 1: Register with the Identity Service

```
POST https://identity.example.com/v1/providers/register

{
  "name": "Your Service Name",
  "domain": "api.yourservice.com",
  "billing_endpoint": "https://api.yourservice.com/aip/billing-callback"
}
```

You'll receive:
- The Identity Service's JWKS endpoint URL for public key retrieval
- The revocation list endpoint URL
- A provider credential for billing API calls

---

## Step 2: Cache Public Keys

Fetch and cache the Identity Service's public keys:

```
GET https://identity.example.com/v1/keys
```

Response (JWKS format):

```json
{
  "keys": [
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "kid": "is_key_2024_03",
      "x": "<base64url-encoded public key>",
      "use": "sig"
    }
  ]
}
```

**Caching rules:**
- Cache JWKS with a 1-hour TTL
- On `unknown_key` errors during verification, refresh the cache immediately (handles key rotation)
- Always validate the `kid` in the token header against cached keys

---

## Step 3: Verify Agent Tokens

When you receive a request with an `Authorization: Agent <token>` header:

### Pseudocode

```python
def verify_agent_token(auth_header: str) -> AgentClaims:
    # Extract token
    scheme, token = auth_header.split(" ", 1)
    if scheme != "Agent":
        raise Unauthorized("invalid_auth_scheme")

    # Decode JWT segments
    header, payload, signature = decode_jwt(token)

    # CRITICAL: reject non-EdDSA algorithms
    if header["alg"] != "EdDSA":
        raise Unauthorized("unsupported_algorithm")

    # Find the signing key
    key = jwks_cache.get(header["kid"])
    if not key:
        jwks_cache.refresh()  # maybe key rotation happened
        key = jwks_cache.get(header["kid"])
        if not key:
            raise Unauthorized("unknown_signing_key")

    # Verify signature
    if not ed25519_verify(key.public_key, signing_input, signature):
        raise Unauthorized("invalid_signature")

    # Check expiry (with 30s clock skew tolerance)
    if payload["exp"] < now() - 30:
        raise Unauthorized("token_expired")

    # Check audience (if your service sets specific audience requirements)
    if payload.get("aud") not in ("*", MY_DOMAIN):
        raise Unauthorized("audience_mismatch")

    # Check IP binding
    if payload.get("bind", {}).get("ip"):
        if not ip_matches(request.remote_addr, payload["bind"]["ip"]):
            raise Unauthorized("ip_mismatch")

    # Check revocation list (if cached)
    if revocation_list.contains(payload["aid"]):
        raise Unauthorized("token_revoked")

    return payload
```

### HTTP Response on Failure

```
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": "aip_token_expired",
  "message": "Agent token has expired",
  "aid": "agt_7f3k9m2x"
}
```

---

## Step 4: Report Usage

After serving a request, report the usage to the identity service for billing:

```
POST https://identity.example.com/v1/billing/report

{
  "mid": "<from token claims>",
  "aid": "<from token claims>",
  "service": "api.yourservice.com",
  "action": "api.read",
  "cost": { "usd": 0.001 },
  "timestamp": 1710001234,
  "request_id": "req_unique_id"
}
```

**Best practices:**
- Batch billing reports (e.g., every 30 seconds or 100 requests)
- Include a unique `request_id` for deduplication
- Retry failed reports with exponential backoff
- If the Identity Service returns `402 Payment Required`, the master identity's balance is exhausted — deny further requests from that `mid`

---

## Step 5 (Optional): Poll Revocation List

For the hybrid revocation model (recommended), periodically poll the revocation list:

```
GET https://identity.example.com/v1/revocations
If-Modified-Since: <last poll timestamp>
```

**Polling rules:**
- Default interval: 5 minutes
- Use `If-Modified-Since` to minimize bandwidth
- Cache the revoked `aid` set in memory for fast lookup during verification
- Entries older than the maximum token TTL (24 hours) can be pruned

---

## Library Support

AIP uses standard JWT with EdDSA, so existing libraries work:

| Language | Library | EdDSA Support |
|----------|---------|---------------|
| TypeScript/JS | `jose` | Yes (native) |
| Python | `PyJWT` + `cryptography` | Yes |
| Go | `go-jose/v4` | Yes |
| Rust | `jsonwebtoken` | Yes |
| Java | `nimbus-jose-jwt` | Yes |

---

## Minimal Express.js Example

```typescript
import express from 'express';
import * as jose from 'jose';

const app = express();

// Cache JWKS
const JWKS = jose.createRemoteJWKSet(
  new URL('https://identity.example.com/v1/keys')
);

// AIP middleware
async function aipAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Agent ')) {
    return res.status(401).json({ error: 'missing_agent_token' });
  }

  try {
    const token = auth.slice(6);
    const { payload } = await jose.jwtVerify(token, JWKS, {
      algorithms: ['EdDSA'],
    });
    req.agent = payload;
    next();
  } catch (err) {
    return res.status(401).json({
      error: 'aip_token_invalid',
      message: err.message,
    });
  }
}

app.get('/api/data', aipAuth, (req, res) => {
  // req.agent contains verified claims
  res.json({ data: '...', agent: req.agent.aid });
});
```

---

## Checklist

- [ ] Registered with identity service
- [ ] JWKS cached with 1-hour TTL and refresh-on-miss
- [ ] `Authorization: Agent <token>` header accepted
- [ ] Algorithm pinned to `EdDSA` only
- [ ] Signature, expiry, and audience verified
- [ ] IP and task binding enforced (if applicable)
- [ ] Usage reported to billing endpoint
- [ ] Revocation list polled (if using hybrid model)
- [ ] Error responses follow AIP error format
