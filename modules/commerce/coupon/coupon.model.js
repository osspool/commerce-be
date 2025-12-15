import mongoose from 'mongoose';

const { Schema } = mongoose;

const couponSchema = new Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
  },
  discountType: {
    type: String,
    enum: ['percentage', 'fixed'],
    required: true,
  },
  discountAmount: {
    type: Number,
    required: true,
    min: [0, 'Discount amount must be positive'],
  },
  minOrderAmount: {
    type: Number,
    default: 0,
  },
  maxDiscountAmount: {
    type: Number,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  usageLimit: {
    type: Number,
    default: 100,
  },
  usedCount: {
    type: Number,
    default: 0,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

// Note: code already has unique:true in field definition (line 9)
couponSchema.index({ expiresAt: 1 });
couponSchema.index({ isActive: 1, expiresAt: 1 });

couponSchema.methods.isValid = function() {
  const now = new Date();
  return this.isActive && this.expiresAt > now && this.usedCount < this.usageLimit;
};

couponSchema.methods.canBeUsed = function(orderAmount) {
  return this.isValid() && orderAmount >= this.minOrderAmount;
};

couponSchema.methods.calculateDiscount = function(orderAmount) {
  if (!this.canBeUsed(orderAmount)) return 0;

  let discount = 0;
  if (this.discountType === 'percentage') {
    discount = (orderAmount * this.discountAmount) / 100;
    if (this.maxDiscountAmount) {
      discount = Math.min(discount, this.maxDiscountAmount);
    }
  } else {
    discount = this.discountAmount;
  }

  return Math.min(discount, orderAmount);
};

const Coupon = mongoose.models.Coupon || mongoose.model('Coupon', couponSchema);
export default Coupon;

