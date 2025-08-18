import jwt from "jsonwebtoken";

export const generateToken = (userId: string): string => {
  const secret = process.env.JWT_SECRET || "aryanseth";
  const payload = { userId };

  const token = jwt.sign(payload, secret, {
    expiresIn: "30d",
  });

  return token;
};
