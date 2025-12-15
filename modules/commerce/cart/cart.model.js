import mongoose from 'mongoose';

const { Schema } = mongoose;

const cartItemSchema = new Schema({
  product: {
    type: Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  variations: Schema.Types.Mixed, // [{ Color: 'Red', Size: 'M' }]
  quantity: {
    type: Number,
    default: 1,
    min: [1, 'Quantity must be at least 1'],
  },
});

const cartSchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },
  items: [cartItemSchema],
}, { timestamps: true });

// Note: user already has unique:true in field definition (line 24)

const Cart = mongoose.models.Cart || mongoose.model('Cart', cartSchema);
export default Cart;

