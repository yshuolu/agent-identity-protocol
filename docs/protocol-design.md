# Agent Identity Protocol (AIP) — Protocol Design

## Core Insight

The fundamental idea: **master identity is a billing/accountability anchor**, and agents are **delegated capability tokens** derived from it. The protocol solves:

1. How agents prove who they are without interactive auth
2. How resource providers verify agents without calling home every time
3. How the master identity retains control

---

## Identity Layers

### Layer 0 — Master Identity
Bound to a human: email + payment method + optionally KYC. This is the accountability root. It never travels. It lives only in the identity service. Think of it like a root CA cert — it signs things, it doesn't go places.

### Layer 1 — Agent Token
A signed, expiring credential derived from the master identity. This is what travels. Agents carry it and present it to resource providers. No login, no OAuth dance — just present the token.

### Layer 2 — Resource Access
Resource providers (APIs, browsers, data services) accept the agent token directly by verifying the signature against the identity service's public key. This is fully offline-verifiable if you use JWT-style signing.

---

## Token Structure

```json
{
  "mid": "master_id_abc123",
  "aid": "agt_7f3k9m",
  "iat": 1710000000,
  "exp": 1710007200,
  "budget": { "usd": 5.00 },
  "bind_ip": null,
  "bind_task": "task_xyz",
  "sig": "<ed25519 signature by identity service>"
}
```

The signature is over the entire payload. Resource providers verify the sig using the identity service's public key — **no network call needed at verification time**.

---

## Protocol Flow

```
1. MINT (human → identity service)
   Human requests an agent for a task.
   Specifies: TTL, optional budget/binding.
   Identity service signs and returns AgentToken.
   Human hands token to agent process.

2. ACCESS (agent → resource)
   Agent presents token in Authorization header:
   Authorization: Agent <base64(AgentToken)>

   Resource provider:
   - Decodes token
   - Verifies signature against identity service pubkey (cached)
   - Checks expiry
   - Optionally: calls identity service to check revocation list

   If valid → serve request, charge against master identity.

3. BILLING (resource → identity service)
   Resource providers report usage against mid (master identity).
   Identity service aggregates and bills the master payment method.
   Agent never handles payment info.

4. REVOKE (human → identity service)
   POST /revoke { aid: "agt_7f3k9m" }
   Identity service adds aid to revocation list.
   Revocation propagates to resource providers on next check.
   Token becomes invalid immediately for providers that check,
   or at next revocation list refresh for offline-verifiers.
```

---

## Role Responsibilities

**Master Human** — the only accountable party. Owns credit, owns revocation power. Never travels with agents. Mints and forgets.

**Identity Service** — the trust anchor. Signs tokens, owns the ledger, settles bills, maintains the revocation list. The only entity all other parties need to trust.

**Agent** — stateless with respect to auth. Carries a token, presents it, never manages credentials. Lives and dies by the token TTL or revocation.

**External Service** — verifies offline (fast path), reports usage asynchronously (billing path), checks revocation only when it needs freshness guarantees. Treats the identity service as a billing + revocation oracle, not a per-request gatekeeper.

---

## Revocation Trade-off

### Model A — Fully Offline (pure JWT)
Providers cache the pubkey and verify locally. No network call. Fast. But revocation only takes effect at token expiry. A compromised agent token lives until TTL.

### Model B — Online Check
Providers call the identity service's revocation endpoint on each request (or each N requests). Immediate revocation. But adds latency and a dependency.

### Model C — Hybrid (Recommended)
Short TTL tokens (15–60 min) + revocation list that providers pull periodically (e.g. every 5 min). Revocation worst-case lag = refresh interval. Agents can be issued a refresh token to re-mint before expiry — which the identity service can deny if revoked.

---

## Ledger Design

### Credit Ledger
Lives on the Identity Service. Tracks `mid → balance`. Services report costs, the Identity Service deducts. Master human tops up via their payment method. This is the financial settlement layer.

### Audit Ledger
Append-only log of `(aid, mid, service, action, cost, timestamp)`. Never mutated, only appended. This is accountability — who did what, when, traceable to a real human.

The agent itself never touches either ledger. It's purely a consumer. The Identity Service and services do all ledger work asynchronously, out of the agent's critical path.

---

## Resource Provider Integration

For a resource provider to join the ecosystem, they need to:

1. **Register** with the identity service — get the pubkey and billing endpoint
2. **Accept** `Authorization: Agent <token>` header
3. **Verify** locally (sig + expiry)
4. **Report** usage to identity service for billing
5. **Poll** revocation list periodically (for Model C)

The identity service needs to be a trusted third party that resource providers are willing to integrate with. Think: what Stripe is for payments, or what Cloudflare is for DNS — a neutral infrastructure layer.

---

## Key Design Decisions

### 1. Token Format — JWT with EdDSA (Ed25519)

JWT provides the envelope format (header.payload.signature, base64url encoded) with universal library support. EdDSA (Ed25519) provides the signing algorithm.

**Why EdDSA over RSA:**
- 32-byte keys vs 256+ byte RSA keys
- 64-byte signatures vs 256+ byte RSA signatures
- Faster signing and verification
- No algorithm confusion attacks (single algorithm, no parameter choices)
- Deterministic signatures (same input always produces same output)

**Why JWT envelope over custom binary:**
- Libraries in every language (jose, jsonwebtoken, PyJWT, etc.)
- Standard tooling for debugging (jwt.io)
- EdDSA support via RFC 8037
- Familiar to developers integrating AIP

JWT header:
```json
{
  "alg": "EdDSA",
  "typ": "JWT",
  "kid": "<key-id>"
}
```

### 2. Identity Service Trust Model
- **Centralized** (you run it) — simplest, good for bootstrapping
- **Federated** (any provider can run one, tokens carry issuer URL) — matters if third parties need to issue master identities
- **Decentralized** (keys on a blockchain/DHT) — probably overkill

### 3. Agent Spawning Agents
Can an agent mint sub-agents? Useful for parallelism (a coordinator agent spawns workers). Rules: sub-agents expire no later than parent. This is the **delegation chain** — same model as X.509 intermediate certs.

### 4. Resource Provider Discovery
How does an agent know which providers accept AIP tokens? Options:
- A registry (identity service hosts it)
- DNS-based (`_aip.provider.com TXT <endpoint>`)
- Configuration at agent spawn time

### 5. Offline Agents
If an agent is running in an air-gapped or intermittent environment, it needs to carry everything in the token. This argues for embedding more context in the token payload, at the cost of token size.

---

## What This Enables

- Agent spawned → immediately has credentials → hits any AIP-compatible API → no login, no API key management, no per-service accounts
- All spend rolls up to one master billing identity
- Human can kill any agent instantly
- Full audit: every resource access is attributable to a specific agent token, traceable to a master identity
- Agents are genuinely stateless with respect to auth — token is self-contained

This is essentially **OAuth 2.0 client credentials flow**, but redesigned assuming the client is an ephemeral AI agent rather than a long-lived service, with the billing/accountability model baked into the protocol itself rather than bolted on.
