import express from "express";
import {
  CreateUser,
  ExecuteOrder,
  getMyProfile,
  LoginUser,
  getMyPortfolio,
  check,
  getMyOrders,
  getMyTransactions,
} from "../controllers/userController.js";
import isAuthenticated from "../middlewares/auth.js";

const router = express.Router();

// login routes
router.route("/signup").post(CreateUser);
router.route("/login").post(LoginUser);
router.route("/check").get(check);

router.use(isAuthenticated);

//profile routes
router.route("/me").get(getMyProfile);
router.route("/portfolio").get(getMyPortfolio);
router.route("/tradeHistory").get(getMyOrders);
router.route("/transactions").get(getMyTransactions);

// order execution route
router.route("/execute").post(ExecuteOrder);

export default router;
