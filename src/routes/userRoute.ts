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
  requestPasswordReset,
  resetPasswordWithOtp,
  refreshToken,
  updateProfile,
  getProfitLoss,
} from "../controllers/userController.js";
import isAuthenticated from "../middlewares/auth.js";

const router = express.Router();

// ─── Public routes ────────────────────────────────────────────────────────────
router.route("/signup").post(CreateUser);
router.route("/login").post(LoginUser);
router.route("/check").get(check);
router.route("/forget").post(requestPasswordReset); // Step 1: send OTP
router.route("/forget/verify").post(resetPasswordWithOtp); // Step 2: verify OTP + new password
router.route("/refresh").post(refreshToken);

// ─── Authenticated routes ─────────────────────────────────────────────────────
//
// `isAuthenticated` is attached PER ROUTE, deliberately.
//
// This router is mounted at "/api/v1/" — the root of the whole API — so a bare
// `router.use(isAuthenticated)` here matched every path under that mount, not
// just this file's routes. Any request that didn't match one of the public
// routes above (e.g. GET /api/v1/commodity/stream, documented as public) was
// rejected with 401 before Express ever reached the commodity or short routers.
// See review A-02.
//
// Per-route middleware cannot leak onto sibling routers, so this cannot regress
// the same way.

// profile routes
router.route("/me").get(isAuthenticated, getMyProfile);
router.route("/profile").put(isAuthenticated, updateProfile);
router.route("/portfolio").get(isAuthenticated, getMyPortfolio);
router.route("/tradehistory").get(isAuthenticated, getMyOrders);
router.route("/transactions").get(isAuthenticated, getMyTransactions);
router.route("/logout").get(isAuthenticated, logout);

// statistics routes
router.route("/stats/pl").get(isAuthenticated, getProfitLoss);

// order execution route
router.route("/execute").post(isAuthenticated, ExecuteOrder);

export default router;
