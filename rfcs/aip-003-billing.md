# AIP-003: Billing & Settlement Specification

**Status:** Draft
**Version:** 0.1.0
**Authors:** Darren Lu

---

## Abstract

This document specifies the billing, credit, and settlement mechanics of AIP. The Identity Service acts as the sole financial clearinghouse — masters fund one account, providers receive settlement from one source. No party other than the Identity Service handles cross-party money movement.

---

## 1. Design Principle

**One payment relationship per party.**

- A master sets up payment **once** with the Identity Service
- A provider sets up payout **once** with the Identity Service
- Agents handle **zero** financial operations
- The Identity Service is the settlement layer between all parties

```
┌──────────┐         ┌──────────────────┐         ┌──────────────┐
│  Master   │──fund──>│  Identity Service │──settle─>│  Provider A  │
│  (Human)  │         │  (Clearinghouse)  │──settle─>│  Provider B  │
│           │<─audit──│                   │──settle─>│  Provider N  │
└──────────┘         └──────────────────┘         └──────────────┘
                       │
                       │ real-time deduction
                       │ from master credit
                       ▼
                     ┌─────────┐
                     │  Agent   │  (no financial role)
                     └─────────┘
```

---

## 2. Credit System

### 2.1 AIP Credits

All billing is denominated in **AIP credits**, pegged 1:1 to USD at time of purchase. Credits are non-refundable, non-transferable between master identities.

The Identity Service maintains a **credit ledger** per master identity:

```
CreditAccount {
  mid:             string       // master identity
  balance:         number       // current credit balance (USD)
  lifetime_funded: number       // total credits ever purchased
  lifetime_spent:  number       // total credits ever consumed
  auto_topup:      AutoTopup?   // optional auto-replenish config
  created_at:      number       // unix timestamp
}
```

### 2.2 Funding

Masters add credits via the Identity Service dashboard or API.

**Request:** `POST /v1/billing/fund`

```json
{
  "amount": { "usd": 50.00 },
  "payment_method_id": "pm_card_abc123"
}
```

**Response:** `200 OK`

```json
{
  "mid": "master_id_abc123",
  "funded": { "usd": 50.00 },
  "balance": { "usd": 73.50 },
  "transaction_id": "txn_fund_8a2b3c"
}
```

Payment processing is delegated to a payment processor (e.g., Stripe). The Identity Service never stores raw card numbers — only tokenized payment method references.

### 2.3 Auto Top-Up

Masters MAY configure automatic replenishment:

```json
{
  "auto_topup": {
    "enabled": true,
    "threshold": { "usd": 10.00 },
    "amount": { "usd": 50.00 },
    "payment_method_id": "pm_card_abc123",
    "monthly_cap": { "usd": 500.00 }
  }
}
```

When `balance` drops below `threshold`, the Identity Service charges `amount` to the payment method. The `monthly_cap` prevents runaway charges.

### 2.4 Budget Allocation

When minting an agent token, the master can set a budget cap:

```json
{
  "ttl": 3600,
  "budget": { "usd": 5.00 }
}
```

The Identity Service **reserves** this amount from the master's balance at mint time:

```
balance: 73.50 → 68.50  (5.00 reserved for agt_7f3k9m2x)
```

Reserved funds are held until the token expires or is revoked. Unused reserved funds are returned to the master's balance.

---

## 3. Usage Reporting

### 3.1 Provider Reports Usage

After serving a request to an agent, the provider reports the cost:

**Request:** `POST /v1/billing/report`

```json
{
  "reports": [
    {
      "mid": "master_id_abc123",
      "aid": "agt_7f3k9m2x",
      "service": "api.example.com",
      "action": "llm.call",
      "cost": { "usd": 0.003 },
      "timestamp": 1710001234,
      "request_id": "req_abc123",
      "metadata": {
        "model": "gpt-4",
        "tokens_in": 150,
        "tokens_out": 500
      }
    }
  ]
}
```

Providers SHOULD batch reports (recommended: every 30 seconds or 100 requests, whichever comes first).

**Response:** `200 OK`

```json
{
  "accepted": 1,
  "rejected": 0,
  "results": [
    {
      "request_id": "req_abc123",
      "status": "accepted",
      "remaining_budget": { "usd": 4.997 }
    }
  ]
}
```

**Error responses:**

| HTTP Status | Error | Meaning |
|-------------|-------|---------|
| `402` | `budget_exhausted` | Agent's budget cap reached — deny further requests |
| `402` | `credit_exhausted` | Master's credit balance is zero |
| `404` | `unknown_agent` | `aid` not found or already expired |
| `409` | `duplicate_report` | `request_id` already processed |

### 3.2 Real-Time Deduction

On each accepted report, the Identity Service:

1. Deducts `cost` from the agent's reserved budget
2. Deducts `cost` from the master's credit balance
3. Credits the provider's settlement balance
4. Appends to the audit ledger

```
Master credit:    68.50 → 68.497
Agent budget:      5.00 →  4.997
Provider balance:  0.00 →  0.003  (owed to provider)
```

### 3.3 Budget Exhaustion

When an agent's remaining budget reaches zero:

1. The Identity Service adds the `aid` to the revocation list with reason `budget_exhausted`
2. The Identity Service returns `402 budget_exhausted` on subsequent billing reports for that `aid`
3. Provider SHOULD deny further requests from this agent

When a master's credit balance reaches zero:

1. The Identity Service adds **all active `aid`s** for that `mid` to the revocation list
2. The Identity Service triggers auto top-up if configured
3. If auto top-up fails or is not configured, all agents for this master are effectively killed

---

## 4. Provider Settlement

### 4.1 Provider Payout Account

Providers register their payout details during onboarding:

**Request:** `POST /v1/providers/payout-setup`

```json
{
  "provider_id": "prv_example_com",
  "payout_method": "stripe_connect",
  "stripe_account_id": "acct_abc123",
  "payout_schedule": "monthly",
  "minimum_payout": { "usd": 25.00 }
}
```

Supported payout methods:
- `stripe_connect` — Stripe Connected Account (recommended)
- `bank_transfer` — Direct ACH/wire transfer
- `paypal` — PayPal business account

### 4.2 Settlement Ledger

The Identity Service maintains a settlement ledger per provider:

```
SettlementAccount {
  provider_id:      string
  pending_balance:  number    // usage reported, not yet settled
  lifetime_earned:  number    // total ever earned
  lifetime_settled: number    // total ever paid out
  last_settlement:  number    // unix timestamp of last payout
}
```

### 4.3 Settlement Cycle

The Identity Service settles with providers on a configurable schedule:

| Schedule | Settlement Day | Payment Arrives |
|----------|---------------|-----------------|
| Weekly | Every Monday | T+2 business days |
| Biweekly | 1st and 15th | T+2 business days |
| Monthly (default) | 1st of month | T+2 business days |

Settlement process:

1. The Identity Service calculates `pending_balance` for the provider
2. The Identity Service deducts its fee (see Section 5)
3. The Identity Service initiates payout via the provider's configured payout method
4. The Identity Service records the settlement in the settlement ledger
5. Provider receives funds

**Request (Identity Service-initiated):** `POST /v1/settlements/execute`

```json
{
  "provider_id": "prv_example_com",
  "period": {
    "from": 1709251200,
    "to": 1711929600
  },
  "gross_amount": { "usd": 1250.00 },
  "fee": { "usd": 62.50 },
  "net_amount": { "usd": 1187.50 },
  "settlement_id": "stl_2024_03_example"
}
```

### 4.4 Settlement Statement

Providers can retrieve their settlement history:

**Request:** `GET /v1/settlements?provider_id=prv_example_com`

```json
{
  "settlements": [
    {
      "settlement_id": "stl_2024_03_example",
      "period": { "from": 1709251200, "to": 1711929600 },
      "gross_amount": { "usd": 1250.00 },
      "fee": { "usd": 62.50 },
      "net_amount": { "usd": 1187.50 },
      "status": "paid",
      "paid_at": 1712016000,
      "line_items_url": "/v1/settlements/stl_2024_03_example/items"
    }
  ]
}
```

### 4.5 Settlement Line Items

Detailed breakdown per master identity:

```json
{
  "items": [
    {
      "mid": "master_id_abc123",
      "total_requests": 4521,
      "total_cost": { "usd": 13.56 },
      "by_action": {
        "api.read": { "count": 4200, "cost": { "usd": 4.20 } },
        "api.write": { "count": 321, "cost": { "usd": 9.36 } }
      }
    }
  ]
}
```

---

## 5. Identity Service Fee Structure

The Identity Service charges a percentage fee on all usage flowing through the platform:

| Tier (monthly volume) | Identity Service Fee |
|------------------------|--------|
| $0 – $1,000 | 5% |
| $1,001 – $10,000 | 4% |
| $10,001 – $100,000 | 3% |
| $100,001+ | Negotiated |

The fee is deducted at settlement time, not at usage reporting time. Providers see the gross amount in real-time, net amount at settlement.

---

## 6. Audit Ledger

### 6.1 Structure

Every financial event is recorded in an append-only audit ledger:

```
AuditEntry {
  entry_id:    string    // globally unique
  timestamp:   number    // unix timestamp
  type:        string    // event type
  mid:         string    // master identity
  aid:         string?   // agent (if applicable)
  provider_id: string?   // provider (if applicable)
  amount:      number    // USD amount
  balance:     number    // resulting balance
  details:     object    // event-specific data
}
```

### 6.2 Event Types

| Type | Description |
|------|-------------|
| `credit.fund` | Master added credits |
| `credit.auto_topup` | Auto top-up triggered |
| `credit.deduct` | Usage deducted from master balance |
| `budget.reserve` | Budget reserved for new agent token |
| `budget.release` | Unused budget returned on token expiry/revocation |
| `budget.deduct` | Usage deducted from agent budget |
| `settlement.execute` | Payout initiated to provider |
| `settlement.complete` | Payout confirmed received |

### 6.3 Access

Masters can query their own audit trail:

**Request:** `GET /v1/billing/audit?mid=master_id_abc123&from=1710000000&to=1710100000`

Providers can query usage attributed to them:

**Request:** `GET /v1/billing/audit?provider_id=prv_example_com&type=settlement.*`

---

## 7. Dispute Resolution

### 7.1 Provider Disputes

If a provider believes usage was underreported or a settlement is incorrect:

**Request:** `POST /v1/settlements/dispute`

```json
{
  "settlement_id": "stl_2024_03_example",
  "reason": "missing_requests",
  "evidence": {
    "reported_request_ids": ["req_abc123", "req_def456"],
    "expected_total": { "usd": 1300.00 },
    "received_total": { "usd": 1250.00 }
  }
}
```

The Identity Service reviews against the audit ledger and resolves within 30 days.

### 7.2 Master Disputes

If a master believes they were overcharged:

**Request:** `POST /v1/billing/dispute`

```json
{
  "mid": "master_id_abc123",
  "period": { "from": 1710000000, "to": 1710100000 },
  "reason": "unauthorized_usage",
  "details": "Agent agt_7f3k9m2x was compromised, charges after 1710050000 are fraudulent"
}
```

The Identity Service can issue credits for verified fraudulent usage.

---

## 8. Pricing Integration

### 8.1 Provider Price Registry

Providers register their pricing with the Identity Service so agents (and masters) can estimate costs before making requests:

**Request:** `POST /v1/providers/pricing`

```json
{
  "provider_id": "prv_example_com",
  "pricing": [
    {
      "action": "api.read",
      "unit": "request",
      "price": { "usd": 0.001 }
    },
    {
      "action": "api.write",
      "unit": "request",
      "price": { "usd": 0.01 }
    },
    {
      "action": "llm.call",
      "unit": "1k_tokens",
      "price": { "usd": 0.03 },
      "metadata": { "model": "default" }
    }
  ]
}
```

### 8.2 Cost Estimation

Agents or masters can query estimated costs:

**Request:** `GET /v1/providers/prv_example_com/pricing?action=api.read`

This is informational only — actual costs are determined by the provider's billing report.

---

## 9. HTTP API Summary

| Method | Path | Actor | Description |
|--------|------|-------|-------------|
| `POST` | `/v1/billing/fund` | Master | Add credits to account |
| `GET` | `/v1/billing/balance` | Master | Check credit balance |
| `PUT` | `/v1/billing/auto-topup` | Master | Configure auto top-up |
| `POST` | `/v1/billing/report` | Provider | Report agent usage |
| `GET` | `/v1/billing/audit` | Master/Provider | Query audit trail |
| `POST` | `/v1/billing/dispute` | Master | Dispute charges |
| `POST` | `/v1/providers/payout-setup` | Provider | Configure payout method |
| `POST` | `/v1/providers/pricing` | Provider | Register pricing |
| `GET` | `/v1/providers/:id/pricing` | Any | Query provider pricing |
| `GET` | `/v1/settlements` | Provider | List settlement history |
| `GET` | `/v1/settlements/:id/items` | Provider | Settlement line items |
| `POST` | `/v1/settlements/dispute` | Provider | Dispute a settlement |

---

## 10. Security & Compliance Considerations

### 10.1 Regulatory
The Identity Service operates as a financial intermediary. Depending on jurisdiction, this may require:
- Money Services Business (MSB) registration (US FinCEN)
- Payment Institution license (EU PSD2)
- PCI DSS compliance for payment method handling
- KYC/AML procedures for master identity verification

### 10.2 Financial Controls
- All monetary operations are idempotent (keyed by `transaction_id`, `request_id`, `settlement_id`)
- Double-entry bookkeeping: every debit has a corresponding credit
- Daily reconciliation between credit ledger, settlement ledger, and audit ledger
- Rate limiting on funding operations to prevent fraud

### 10.3 Data Retention
- Audit ledger entries MUST be retained for 7 years (financial compliance)
- Settlement records MUST be retained for 7 years
- Usage reports MAY be aggregated after 90 days (detail discarded, totals kept)
