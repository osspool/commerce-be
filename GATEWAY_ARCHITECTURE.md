# Payment Gateway Architecture

Complete guide to payment gateway integration using `@classytic/revenue`.

---

## Overview

The payment system uses **@classytic/revenue** library which supports **multiple payment gateways** simultaneously.

### Key Concepts

| Concept | Description | Example |
|---------|-------------|---------|
| **Method** | User-facing payment method | `'cash'`, `'bkash'`, `'card'` |
| **Gateway** | Backend provider processing payment | `'manual'`, `'stripe'`, `'sslcommerz'` |
| **Provider** | Implementation class for gateway | `ManualProvider`, `StripeProvider` |

---

## Current Setup

### Registered Providers ([revenue.plugin.js:14-19](common/plugins/revenue.plugin.js#L14-L19))

```javascript
const providers = {
  manual: new ManualProvider({
    logger: fastify.log,
  }),
  // Future providers:
  // stripe: new StripeProvider({ apiKey: '...' }),
  // sslcommerz: new SSLCommerzProvider({ storeId: '...', password: '...' }),
  // bkash_api: new BkashProvider({ appKey: '...', appSecret: '...' }),
};
```

### Current Payment Methods → Gateway Mapping

| Payment Method | Gateway Used | Requires Manual Verification |
|----------------|--------------|------------------------------|
| `cash` | `manual` | ✅ Yes |
| `bkash` (manual) | `manual` | ✅ Yes |
| `nagad` (manual) | `manual` | ✅ Yes |
| `rocket` (manual) | `manual` | ✅ Yes |
| `bank` | `manual` | ✅ Yes |

---

## How It Works

### 1. Customer Places Order

**Request:**
```json
{
  "items": [...],
  "deliveryAddress": {...},
  "delivery": {...},
  "paymentData": {
    "method": "bkash",      // ← User-facing method
    "gateway": "manual",    // ← Optional: Backend gateway (defaults to "manual")
    "reference": "BGH3K5L90P",
    "senderPhone": "01712345678"
  }
}
```

### 2. Workflow Processes Payment

**Code:** [create-order.workflow.js:268-270](modules/commerce/order/workflows/create-order.workflow.js#L268-L270)
```javascript
const paymentMethod = paymentData.method || 'cash';
const paymentGateway = paymentData.gateway || 'manual';
```

### 3. Revenue Creates Transaction

**Code:** [create-order.workflow.js:328-345](modules/commerce/order/workflows/create-order.workflow.js#L328-L345)
```javascript
await revenue.monetization.create({
  gateway: paymentGateway,  // ← Uses provider registered with this name
  paymentData: {
    method: paymentMethod,  // ← Stored for display
    trxId: paymentReference,
    walletNumber: senderPhone
  },
  amount: amountInPaisa,
  currency: 'BDT'
});
```

### 4. Gateway Processes Payment

**For Manual Gateway:**
- Returns pending status
- Admin manually verifies via `/webhooks/payments/manual/verify`
- Updates order to `confirmed`

**For Automated Gateways (Future):**
- Creates payment session (e.g., Stripe checkout)
- Returns `paymentIntent` with redirect URL
- Gateway sends webhook on payment success
- Automatically updates order to `confirmed`

---

## Adding New Payment Gateways

### Example: Adding Stripe

#### Step 1: Install Provider Package

```bash
npm install @classytic/revenue-stripe
```

Or create custom provider:

```bash
# Create provider file
touch common/providers/stripe.provider.js
```

#### Step 2: Create Provider Class

```javascript
// common/providers/stripe.provider.js
import { PaymentProvider, PaymentIntent, PaymentResult } from '@classytic/revenue';
import Stripe from 'stripe';

export class StripeProvider extends PaymentProvider {
  constructor(config) {
    super(config);
    this.name = 'stripe';
    this.stripe = new Stripe(config.apiKey);
  }

  async createIntent(params) {
    // Create Stripe checkout session
    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: params.currency.toLowerCase(),
          product_data: { name: 'Order Payment' },
          unit_amount: params.amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${params.metadata.returnUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: params.metadata.cancelUrl,
    });

    return new PaymentIntent({
      id: session.id,
      sessionId: session.id,
      paymentIntentId: session.payment_intent,
      provider: 'stripe',
      status: 'pending',
      amount: params.amount,
      currency: params.currency,
      paymentUrl: session.url, // ← Redirect user here
      expiresAt: new Date(session.expires_at * 1000),
    });
  }

  async verifyPayment(sessionId) {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);

    return new PaymentResult({
      id: sessionId,
      provider: 'stripe',
      status: session.payment_status === 'paid' ? 'succeeded' : 'pending',
      amount: session.amount_total,
      currency: session.currency.toUpperCase(),
      paidAt: session.payment_status === 'paid' ? new Date() : null,
    });
  }

  async handleWebhook(payload, headers) {
    const sig = headers['stripe-signature'];
    const event = this.stripe.webhooks.constructEvent(
      payload,
      sig,
      this.config.webhookSecret
    );

    return {
      type: event.type === 'checkout.session.completed' ? 'payment.succeeded' : 'payment.failed',
      data: {
        sessionId: event.data.object.id,
        paymentIntentId: event.data.object.payment_intent,
      },
      id: event.id,
      createdAt: new Date(event.created * 1000),
    };
  }

  getCapabilities() {
    return {
      supportsWebhooks: true,
      supportsRefunds: true,
      supportsPartialRefunds: true,
      requiresManualVerification: false, // ← Automated!
    };
  }
}
```

#### Step 3: Register Provider

```javascript
// common/plugins/revenue.plugin.js
import { StripeProvider } from '../providers/stripe.provider.js';

const providers = {
  manual: new ManualProvider({ logger: fastify.log }),
  stripe: new StripeProvider({
    apiKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    logger: fastify.log,
  }),
};
```

#### Step 4: Add Webhook Route

```javascript
// routes/webhooks/payment-webhook.plugin.js
fastify.post('/stripe', async (request, reply) => {
  const result = await fastify.revenue.payments.handleWebhook(
    'stripe',
    request.body,
    request.headers
  );
  return { received: true };
});
```

#### Step 5: Update Frontend

```javascript
// Frontend: Customer selects Stripe
const orderData = {
  items: [...],
  deliveryAddress: {...},
  delivery: {...},
  paymentData: {
    method: "card",      // ← User-facing method
    gateway: "stripe",   // ← Use Stripe gateway
  }
};

const result = await createOrder(orderData);

// For Stripe: Redirect to checkout
if (result.paymentIntent?.paymentUrl) {
  window.location.href = result.paymentIntent.paymentUrl;
}
```

---

## Gateway Comparison

| Feature | Manual | Stripe | SSLCommerz | bKash API |
|---------|--------|--------|------------|-----------|
| **Auto-verification** | ❌ | ✅ | ✅ | ✅ |
| **Webhook support** | ❌ | ✅ | ✅ | ✅ |
| **Requires redirect** | ❌ | ✅ | ✅ | ✅ |
| **Payment methods** | Cash, Manual transfers | Cards | Cards, Mobile | bKash only |
| **Best for** | COD, Manual verification | International cards | Bangladesh cards | bKash users |
| **Setup complexity** | Simple | Medium | Medium | Complex |

---

## Payment Flow Comparison

### Manual Gateway (Current)

```
Customer → Places order → Status: pending
                ↓
         Order created with TrxID
                ↓
          Admin verifies
                ↓
         Status: confirmed
```

### Automated Gateway (Future: Stripe)

```
Customer → Places order → Creates payment intent
                ↓
      Redirect to Stripe checkout
                ↓
      Customer pays with card
                ↓
       Stripe sends webhook
                ↓
       Auto status: confirmed
```

---

## Configuration

### Environment Variables

```env
# Manual Provider (Current)
# No config needed - already working!

# Future: Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Future: SSLCommerz
SSLCOMMERZ_STORE_ID=your_store_id
SSLCOMMERZ_STORE_PASSWORD=your_password
SSLCOMMERZ_IS_SANDBOX=true

# Future: bKash API
BKASH_APP_KEY=your_app_key
BKASH_APP_SECRET=your_app_secret
BKASH_USERNAME=merchant_username
BKASH_PASSWORD=merchant_password
BKASH_IS_SANDBOX=true
```

---

## Testing

### Manual Gateway (Current)

```bash
# 1. Create order
curl -X POST http://localhost:3000/api/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [...],
    "paymentData": {
      "method": "bkash",
      "gateway": "manual",
      "reference": "TEST123",
      "senderPhone": "01712345678"
    }
  }'

# 2. Verify payment (as admin)
curl -X POST http://localhost:3000/api/v1/webhooks/payments/manual/verify \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "transactionId": "txn_id_from_order"
  }'
```

### Stripe Gateway (Future)

```bash
# 1. Create order with Stripe
curl -X POST http://localhost:3000/api/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [...],
    "paymentData": {
      "method": "card",
      "gateway": "stripe"
    }
  }'

# Response includes paymentIntent.paymentUrl
# Redirect user to this URL

# 2. Stripe automatically sends webhook
# No manual verification needed!
```

---

## Migration Path

### Current State (Phase 1) ✅
- **Manual gateway only**
- All payments require admin verification
- Working for COD and manual mobile payments

### Phase 2 (Future)
- **Add Stripe** for international cards
- Manual gateway still available for COD
- Both gateways work simultaneously

### Phase 3 (Future)
- **Add SSLCommerz** for Bangladesh cards/mobile
- **Add bKash API** for automated bKash payments
- Keep manual as fallback

### Phase 4 (Future)
- Add Nagad API, Rocket API
- Multiple gateways running in parallel
- User chooses based on preference

---

## Best Practices

### ✅ Do's

1. **Always specify gateway explicitly** when you know the provider
2. **Use meaningful payment methods** (`'card'` not `'stripe'`)
3. **Handle paymentIntent redirects** for automated gateways
4. **Store customer payment references** (`reference`, `senderPhone`)
5. **Test webhooks** with provider test mode

### ❌ Don'ts

1. Don't mix up `method` and `gateway` - they're different!
2. Don't hardcode gateway in frontend - get from backend config
3. Don't skip webhook signature verification
4. Don't manually verify automated gateway payments
5. Don't expose gateway credentials in frontend

---

## Documentation

- **@classytic/revenue**: Main library documentation
- **@classytic/revenue-manual**: Manual provider (current)
- **Order API Guide**: [ORDER_API_GUIDE.md](ORDER_API_GUIDE.md)
- **Frontend Guide**: [FRONTEND_INTEGRATION_GUIDE.md](FRONTEND_INTEGRATION_GUIDE.md)

---

**Version:** 1.0
**Last Updated:** December 2025
