import { Schema, model } from "mongoose";

const userSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  password: { type: String, required: true },
  isAdmin: { type: Boolean, required: true, default: false },
  accountBalance: { type: Number, required: true, default: 1000000 },
  accountCreated: { type: Date, default: Date.now },
});

export const User = model("User", userSchema);
