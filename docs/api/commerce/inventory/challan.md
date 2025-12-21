# Challan (Transfer) Reference

Detailed reference for transfer/challan documents, status history, and lookup options.

## Challan Number Format

Transfers are assigned a unique challan number on creation:

```
CHN-YYYYMM-NNNN
```

Example: `CHN-202512-0042` (42nd challan of December 2025)

## Lookup by Challan Number

The transfer endpoint accepts both ID and challan number:

```http
GET /api/v1/inventory/transfers/CHN-202512-0042
```

The server auto-detects the format and routes appropriately.

## Transfer Document Structure

```json
{
  "_id": "transfer_id",
  "challanNumber": "CHN-202512-0042",
  "transferType": "head_to_sub",
  "status": "dispatched",
  "documentType": "delivery_challan",

  "senderBranch": { "_id": "...", "code": "HO", "name": "Head Office" },
  "receiverBranch": { "_id": "...", "code": "DHK", "name": "Dhaka Store" },

  "items": [
    {
      "product": "product_id",
      "productName": "Cotton T-Shirt",
      "variantSku": "TSHIRT-M-RED",
      "quantity": 10,
      "quantityReceived": 0,
      "costPrice": 250
    }
  ],

  "totalValue": 2500,

  "transport": {
    "vehicleNumber": "DHA-1234",
    "driverName": "Rahim",
    "driverPhone": "017XXXXXXXX",
    "estimatedArrival": "2025-12-20T12:00:00.000Z"
  },

  "statusHistory": [
    { "status": "draft", "timestamp": "...", "actor": "user_id", "notes": null },
    { "status": "approved", "timestamp": "...", "actor": "user_id", "notes": null },
    { "status": "dispatched", "timestamp": "...", "actor": "user_id", "notes": null }
  ],

  "dispatchMovements": ["movement_id_1", "movement_id_2"],
  "receiveMovements": [],

  "remarks": "Weekly replenishment",
  "createdAt": "2025-12-15T08:00:00.000Z",
  "updatedAt": "2025-12-15T10:30:00.000Z"
}
```

## Status Flow

```
draft ──→ approved ──→ dispatched ──→ in_transit ──→ received
                                                  ↘ partial_received
  │
  └──→ cancelled (from draft or approved only)
```

| Status | Stock Impact | Description |
|--------|--------------|-------------|
| `draft` | None | Transfer created, editable |
| `approved` | None | Validated, ready for dispatch |
| `dispatched` | Sender decremented | Stock left sender warehouse |
| `in_transit` | None | Package in transit (optional step) |
| `received` | Receiver incremented | Full receipt confirmed |
| `partial_received` | Receiver incremented (partial) | Some items received, discrepancy noted |
| `cancelled` | None (or reversed) | Transfer aborted |

## Transfer Types

| Type | Sender | Receiver | Permission |
|------|--------|----------|------------|
| `head_to_sub` | Head Office | Sub-branch | Standard (default) |
| `sub_to_sub` | Sub-branch | Sub-branch | Admin only |
| `sub_to_head` | Sub-branch | Head Office | Admin only |

Type is auto-determined from sender/receiver branch roles.

**Permission notes:**
- `head_to_sub` is restricted to head office roles (warehouse/admin).
- `sub_to_sub` and `sub_to_head` are restricted to admin/superadmin.

## Document Types

| Value | Description |
|-------|-------------|
| `delivery_challan` | Standard delivery document (default) |
| `dispatch_note` | Dispatch document |
| `delivery_slip` | Delivery slip |

## Cost Price Propagation

1. Sender branch `StockEntry.costPrice` is captured at dispatch
2. On receive, receiver's `StockEntry.costPrice` is updated using weighted average:
   ```
   newCost = (existingQty × existingCost + receivedQty × transferCost) / totalQty
   ```
3. This maintains accurate COGS across the distribution chain

## Status History

Every status change is recorded in `statusHistory[]`:

```json
{
  "status": "dispatched",
  "timestamp": "2025-12-15T10:30:00.000Z",
  "actor": "user_id",
  "notes": "Dispatched via DHA-1234"
}
```

Use this for audit trails and delivery tracking.

## Movement Linking

After dispatch/receive, movement IDs are stored:
- `dispatchMovements[]` - StockMovement IDs for sender decrements
- `receiveMovements[]` - StockMovement IDs for receiver increments

Query these for detailed audit:
```http
GET /api/v1/inventory/movements?type=transfer_out&reference.id=<transferId>
```

## Data Retention

Completed and cancelled transfers are automatically deleted after **2 years** via MongoDB TTL index.

## Related Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/inventory/transfers/stats` | Counts by status, pending actions |
| GET | `/api/v1/inventory/challans/:challanNumber` | Lookup by challan number |
