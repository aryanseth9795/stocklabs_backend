import jwt from "jsonwebtoken";

const secret = process.env.JWT_SECRET || "aryanseth";

export const generateToken = (userId: string): string => {
  const payload = { userId };
  const token = jwt.sign(payload, secret, {
    expiresIn: "30d",
  });

  return token;
};
