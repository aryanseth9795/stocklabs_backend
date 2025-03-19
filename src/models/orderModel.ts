import { Schema, model } from "mongoose";

const stockSchema = new Schema({
  stockSymbol: { type: String, required: true },
  stockName: { type: String, required: true },
  stockPrice: { type: Number, required: true },
  stockQuantity: { type: Number, required: true },
  stockTotal: { type: Number, required: true },
  user: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  time: { type: Date, default: Date.now },
});

export const Order = model("Order", stockSchema);
