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
  logout,
  forgetPassword,
} from "../controllers/userController.js";
import isAuthenticated from "../middlewares/auth.js";


const router = express.Router();

// login routes
router.route("/signup").post(CreateUser);
router.route("/login").post(LoginUser);
router.route("/check").get(check);
router.route("/forget").post(forgetPassword);

// Apply authentication middleware
router.use(isAuthenticated);

//profile routes
router.route("/me").get(getMyProfile);
router.route("/portfolio").get(getMyPortfolio);
router.route("/tradehistory").get(getMyOrders);
router.route("/transactions").get(getMyTransactions);
router.route("/logout").get(logout);

// order execution route
router.route("/execute").post(ExecuteOrder);

export default router;
