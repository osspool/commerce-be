# Payment Reference Flow - @classytic/revenue Integration

## ✅ Complete Flow (Verified)

### 1. **Customer Places Order** ([create-order.workflow.js:267-343](modules/commerce/order/workflows/create-order.workflow.js#L267-L343))

**Customer provides payment data:**
```json
{
  "paymentData": {
    "method": "bkash",
    "reference": "BGH3K5L90P",
    "senderPhone": "01712345678"
  }
}
```

**Workflow stores in Order:**
```javascript
order.currentPayment = {
  method: "bkash",
  reference: "BGH3K5L90P",  // ✅ Customer's TrxID stored here
  amount: 156000,
  status: "pending",
  transactionId: null  // Will be linked after transaction creation
}
```

### 2. **Transaction Creation** ([create-order.workflow.js:313-325](modules/commerce/order/workflows/create-order.workflow.js#L313-L325))

**Workflow builds paymentData using revenue library schema:**
```javascript
const transactionPaymentData = {
  method: "bkash",
  trxId: "BGH3K5L90P",  // ✅ Uses correct schema field name
  walletNumber: "01712345678",
  // ... other paymentDetailsSchema fields
};

await revenue.monetization.create({
  paymentData: transactionPaymentData,
  metadata: {
    orderId: order._id,
    senderPhone: "01712345678",
    paymentReference: "BGH3K5L90P",  // ✅ Stored in metadata too
  }
});
```

**Resulting Transaction:**
```javascript
transaction = {
  _id: "txn_id",
  amount: 156000,
  status: "pending",
  method: "bkash",
  paymentDetails: {
    provider: "manual",
    method: "bkash",
    trxId: "BGH3K5L90P",  // ✅ Customer's TrxID
    walletNumber: "01712345678"
  },
  metadata: {
    orderId: "order_id",
    senderPhone: "01712345678",
    paymentReference: "BGH3K5L90P"
  },
  referenceModel: "Order",
  referenceId: "order_id"
}
```

### 3. **Admin Views Order**

Admin dashboard displays:
- **Order ID**: `order_id`
- **Payment Method**: `bkash`
- **Customer TrxID**: `BGH3K5L90P` (from `order.currentPayment.reference`)
- **Sender Phone**: `01712345678` (from `transaction.metadata.senderPhone`)
- **Amount**: `1560 BDT`

Admin can now verify in bKash merchant panel using the TrxID.

### 4. **Admin Verifies Payment** ([revenue.plugin.js:48-67](common/plugins/revenue.plugin.js#L48-L67))

**Admin calls:**
```http
POST /api/v1/webhooks/payments/manual/verify
{
  "transactionId": "txn_id",
  "notes": "Verified in bKash - TrxID: BGH3K5L90P"
}
```

**Revenue library triggers `payment.verified` hook:**
```javascript
'payment.verified': [
  async ({ transaction, verifiedBy }) => {
    // Hook calls updateEntityAfterPaymentVerification
    await updateEntityAfterPaymentVerification(
      transaction.referenceModel,  // "Order"
      transaction.referenceId,     // order_id
      transaction,
      fastify.log
    );
  }
]
```

### 5. **Payment Verification Updates Order** ([payment-verification.utils.js:71-92](common/revenue/payment-verification.utils.js#L71-L92))

**CRITICAL: Preserves customer's payment reference!**
```javascript
// Preserve customer's TrxID before updating
const existingReference = order.currentPayment.reference  // "BGH3K5L90P"
  || transaction.paymentDetails?.trxId;  // Fallback

// Update payment status
order.currentPayment.status = "verified";
order.currentPayment.verifiedAt = new Date();
order.currentPayment.verifiedBy = admin_id;
order.currentPayment.transactionId = transaction._id;

// ✅ PRESERVE the customer's TrxID
if (existingReference) {
  order.currentPayment.reference = existingReference;  // Still "BGH3K5L90P"
}

// Update order status
order.status = "confirmed";
```

**Final Order State:**
```javascript
order = {
  _id: "order_id",
  status: "confirmed",  // ✅ Updated
  currentPayment: {
    transactionId: "txn_id",
    amount: 156000,
    method: "bkash",
    status: "verified",  // ✅ Updated
    reference: "BGH3K5L90P",  // ✅ PRESERVED!
    verifiedAt: "2025-12-05T10:30:00Z",
    verifiedBy: "admin_id"
  }
}
```

---

## 🔐 Key Points

1. **Customer's TrxID is stored in TWO places:**
   - `order.currentPayment.reference` - Primary source
   - `transaction.paymentDetails.trxId` - Backup source

2. **Payment verification preserves the reference:**
   - Checks existing `order.currentPayment.reference` first
   - Falls back to `transaction.paymentDetails.trxId` if needed
   - Always maintains customer's original TrxID

3. **Compatible with @classytic/revenue:**
   - Uses correct `paymentDetailsSchema` fields
   - Works with manual provider verification flow
   - Properly triggers hooks and updates entities

4. **Admin has all info for verification:**
   - Customer's TrxID from `order.currentPayment.reference`
   - Sender phone from `transaction.metadata.senderPhone`
   - Amount from `order.totalAmount`

---

## 📊 Schema Alignment

### Order Model ([order.model.js:68-69](modules/commerce/order/order.model.js#L68-L69))
```javascript
currentPayment: currentPaymentSchema  // From @classytic/revenue
// Includes: transactionId, amount, status, method, reference, verifiedAt, verifiedBy
```

### Transaction Model ([transaction.model.js:86](modules/transaction/transaction.model.js#L86))
```javascript
paymentDetails: paymentDetailsSchema  // From @classytic/revenue
// Includes: provider, walletNumber, walletType, trxId, bankName, accountNumber, accountName, proofUrl
```

### currentPaymentSchema (from @classytic/revenue)
```javascript
{
  transactionId: ObjectId,
  amount: Number,
  status: String,  // "pending" | "verified" | "failed" | "refunded"
  method: String,
  reference: String,  // ✅ Customer's TrxID stored here
  verifiedAt: Date,
  verifiedBy: ObjectId
}
```

---

## ✅ Integration Verified

All components correctly integrate with `@classytic/revenue`:
- ✅ Uses library's schemas (`currentPaymentSchema`, `paymentDetailsSchema`)
- ✅ Uses library's enums (`PAYMENT_STATUS`, `TRANSACTION_STATUS`)
- ✅ Follows library's hook pattern (`payment.verified`)
- ✅ Works with ManualProvider verification flow
- ✅ Preserves custom fields (reference) through verification lifecycle
