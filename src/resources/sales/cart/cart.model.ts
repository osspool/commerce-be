import mongoose, { Schema, type HydratedDocument, type Types } from 'mongoose';

export interface ICartItem {
  product: Types.ObjectId;
  variantSku: string | null;
  quantity: number;
}

export interface ICart {
  user: Types.ObjectId;
  items: Types.DocumentArray<ICartItem>;
  createdAt: Date;
  updatedAt: Date;
}

export type CartDocument = HydratedDocument<ICart>;

const cartItemSchema = new Schema<ICartItem>({
  product: {
    type: Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
  },
  variantSku: {
    type: String,
    default: null,
  },
  quantity: {
    type: Number,
    default: 1,
    min: [1, 'Quantity must be at least 1'],
  },
});

const cartSchema = new Schema<ICart>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    items: [cartItemSchema],
  },
  { timestamps: true },
);

// Note: user already has unique:true in field definition (line 24)

const Cart = mongoose.models.Cart || mongoose.model<ICart>('Cart', cartSchema);
export default Cart;
