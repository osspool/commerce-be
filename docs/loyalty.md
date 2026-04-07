# Loyalty System

Points-based membership program powered by `@classytic/loyalty`.

## Quick Start

```bash
# 1. Enroll a customer
POST /api/v1/loyalty/members
{ "customerId": "67abc123..." }

# 2. Check their balance
GET /api/v1/loyalty/members/67abc123...

# 3. Adjust points (admin)
POST /api/v1/loyalty/members/67abc123.../adjust
{ "points": 500, "reason": "Welcome bonus" }

# 4. View history
GET /api/v1/loyalty/members/67abc123.../history?page=1&limit=20
```

## Architecture

```
PlatformConfig (admin settings)
    │
    ├── tiers: [{ name, minPoints, pointsMultiplier, discountPercent }]
    ├── pointsPerAmount / amountPerPoint / roundingMode
    └── redemption: { enabled, pointsPerBdt, maxRedeemPercent, ... }
    │
    ▼
Loyalty Engine (@classytic/loyalty)
    │
    ├── LoyaltyMember      ← linked to Customer via externalId
    ├── PointTransaction    ← full audit ledger (earn, redeem, adjust, expire)
    ├── Redemption          ← reserve → confirm/release lifecycle
    └── Events              ← syncs Customer.membership thin field
    │
    ▼
Customer.membership (thin field — read cache, synced via events)
    │
    ├── cardId, isActive, tier
    └── points: { current, lifetime, redeemed }
```

**Why two models?**
- `LoyaltyMember` is the source of truth (with transaction history, race-safe operations)
- `Customer.membership` is a read-optimized snapshot (for POS card lookups, customer list display)

## API Endpoints

### Member Management

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/loyalty/members` | Enroll customer `{ customerId }` |
| `GET` | `/loyalty/members/:customerId` | Get member + balance |
| `POST` | `/loyalty/members/:customerId/deactivate` | Deactivate membership |
| `POST` | `/loyalty/members/:customerId/reactivate` | Reactivate membership |
| `POST` | `/loyalty/members/:customerId/adjust` | Adjust points `{ points, reason }` |
| `GET` | `/loyalty/members/:customerId/history` | Transaction history (paginated) |

### Self-Service (Authenticated Users)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/loyalty/me/enroll` | Self-enroll |
| `GET` | `/loyalty/me` | My loyalty status + balance |

### Legacy (Still Works)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/customers/:id/membership` | Action-based: `{ action: 'enroll' \| 'deactivate' \| 'reactivate' \| 'adjust' }` |

## POS Checkout Flow

```
1. Customer scans membership card
   → lookupByCardId() on Customer.membership.cardId

2. Tier discount applied
   → getTierDiscountPercent(tier, platformConfig.membership)

3. Points redemption (if requested)
   → engine.services.redemption.validate({ memberId, pointsToRedeem, orderTotal })
   → engine.services.redemption.reserve({ memberId, pointsToRedeem, orderTotal, ownerType: 'Order', ownerId })

4. Order created
   → On success: engine.services.redemption.confirm(reservationId)
   → On failure: engine.services.redemption.release(reservationId)

5. Points earned
   → engine.services.ledger.earnPoints({ memberId, points, idempotencyKey: 'pos_earn:orderId' })
   → loyaltyBridge.syncCustomerMembership(customerId)
```

## Key Files

```
src/resources/sales/loyalty/
├── loyalty.plugin.ts      — Engine init, getLoyaltyEngine(), setLoyaltyEngine()
├── loyalty.bridge.ts      — Customer ↔ LoyaltyMember bridge + POS helpers
├── loyalty.handler.ts     — HTTP handlers (8 endpoints)
├── loyalty.resource.ts    — Arc defineResource()
├── loyalty.events.ts      — Sync Customer.membership from engine events
└── routes.ts              — Plugin export
```

## Configuration

All loyalty settings live in **Platform Config** (`PATCH /api/v1/platform/config`):

```json
{
  "membership": {
    "enabled": true,
    "pointsPerAmount": 1,
    "amountPerPoint": 100,
    "roundingMode": "floor",
    "tiers": [
      { "name": "Bronze", "minPoints": 0, "pointsMultiplier": 1 },
      { "name": "Silver", "minPoints": 500, "pointsMultiplier": 1.5 },
      { "name": "Gold", "minPoints": 2000, "pointsMultiplier": 2, "discountPercent": 5 }
    ],
    "redemption": {
      "enabled": true,
      "pointsPerBdt": 10,
      "maxRedeemPercent": 50,
      "minRedeemPoints": 100,
      "minOrderAmount": 500
    }
  }
}
```

The loyalty engine reads these at startup via `loyalty.plugin.ts`.

## SDK Integration (Frontend)

```tsx
import {
  useLoyaltyMember,
  useLoyaltyHistory,
  useLoyaltyActions,
  useMyLoyalty,
  useSelfEnroll,
} from '@classytic/commerce-sdk/sales';

// Customer-facing
function LoyaltyCard({ token }) {
  const { data } = useMyLoyalty(token);
  const { selfEnroll, isPending } = useSelfEnroll(token);

  if (!data?.enrolled) return <Button onClick={() => selfEnroll()}>Join Rewards</Button>;
  return <p>{data.balance.current} points</p>;
}

// Admin
function AdminLoyalty({ token, customerId }) {
  const { data } = useLoyaltyMember(token, customerId);
  const { data: history } = useLoyaltyHistory(token, customerId);
  const { enroll, adjustPoints, deactivate } = useLoyaltyActions(token);

  await adjustPoints(customerId, { points: 500, reason: 'Birthday bonus' });
}
```

## Race Condition Safety

The loyalty engine protects against:

| Attack | Protection |
|--------|-----------|
| Double-spend (concurrent adjustments) | Post-`$inc` balance check inside transaction — rolls back if negative |
| Double-confirm redemption | Atomic `findOneAndUpdate({ status: 'reserved' })` — second call fails |
| Concurrent reservations overdraw | Post-`$inc` balance check after reserve deduction |
| Duplicate point earning | Unique index on `idempotencyKey` + in-transaction re-check |
| Double expiration processing | Marks original tx with `expiredAt` — `findExpired` skips it |

## Testing

```bash
# Loyalty package tests (157 tests including 28 adversarial security tests)
cd packages/loyalty && npm test

# be-prod integration tests (50 tests)
cd be-prod && npx vitest run tests/customer-membership.test.ts tests/integration/loyalty-bridge.test.ts tests/integration/loyalty-e2e.test.ts
```

### E2E scenarios covered:
- Enrollment lifecycle (enroll, deactivate, block operations, reactivate)
- Point earning (balance update, idempotency, accumulation)
- Point adjustment (bonus, correction, insufficient guard, NaN/Infinity rejection)
- Redemption (validate → reserve → confirm, reserve → release, min points, max percent cap, double-confirm prevention)
- Concurrent safety (parallel adjustments, parallel reservations)
- Transaction history (full audit trail, pagination)
- Bridge sync (LoyaltyMember → Customer.membership thin field)
- Full POS flow (enroll → earn → redeem → earn again)
