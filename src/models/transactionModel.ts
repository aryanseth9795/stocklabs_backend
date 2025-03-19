import { model, Schema } from "mongoose";

const transactionSchema = new Schema({
  orderId: {
    type: Schema.Types.ObjectId,
    ref: "Order",
    required: true,
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  openingAmount: { type: Number, required: true },
  closingAmount: { type: Number, required: true },
  usedBalance: { type: Number, required: true },
  status: { type: String, required: true },
  time: { type: Date, default: Date.now },
});

export const Transaction = model("Transaction", transactionSchema);
