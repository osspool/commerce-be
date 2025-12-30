import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Stock Movement Model (Audit Trail)
 *
 * Records every stock change for auditing, reporting, and debugging.
 * Immutable - documents are never updated, only created.
 *
 * Movement types:
 * - sale: Stock decreased due to order
 * - return: Stock restored due to order cancellation/return
 * - adjustment: Manual stock correction (damaged, lost, etc.)
 * - transfer_in: Received from another branch
 * - transfer_out: Sent to another branch
 * - initial: Initial stock setup
 * - recount: Physical inventory count adjustment
 * - purchase: Stock received from supplier/purchase order
 */
const stockMovementSchema = new Schema({
  stockEntry: {
    type: Schema.Types.ObjectId,
    ref: 'StockEntry',
    required: true,
    index: true,
  },

  product: {
    type: Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
    index: true,
  },

  variantSku: {
    type: String,
    trim: true,
  },

  branch: {
    type: Schema.Types.ObjectId,
    ref: 'Branch',
    required: true,
    index: true,
  },

  // Movement type
  type: {
    type: String,
    enum: ['sale', 'return', 'adjustment', 'transfer_in', 'transfer_out', 'initial', 'recount', 'purchase'],
    required: true,
    index: true,
  },

  // Quantity change (negative for outgoing, positive for incoming)
  quantity: {
    type: Number,
    required: true,
  },

  // Resulting balance after this movement
  balanceAfter: {
    type: Number,
    required: true,
  },

  // Cost per unit (for purchase/initial movements)
  costPerUnit: {
    type: Number,
    min: 0,
  },

  // Reference to source document
  reference: {
    model: {
      type: String,
    enum: ['Order', 'Transfer', 'Purchase', 'PurchaseOrder', 'Manual', 'Challan'],
    },
    id: Schema.Types.ObjectId,
  },

  // Who made the change
  actor: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },

  notes: String,

}, {
  timestamps: true,
  // Prevent updates - movements are immutable
  strict: true,
});

// Indexes for reporting
stockMovementSchema.index({ stockEntry: 1, createdAt: -1 });
stockMovementSchema.index({ product: 1, branch: 1, createdAt: -1 });
stockMovementSchema.index({ type: 1, createdAt: -1 });
stockMovementSchema.index({ 'reference.model': 1, 'reference.id': 1 });

// TTL index - automatically delete movements older than 2 years
// MongoDB's TTL monitor runs every 60 seconds and removes expired documents
stockMovementSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 63072000 } // 2 years = 730 days = 63,072,000 seconds
);

const StockMovement = mongoose.models.StockMovement || mongoose.model('StockMovement', stockMovementSchema);
export default StockMovement;
