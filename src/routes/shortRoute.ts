import express from "express";
import {
  executeShortSell,
  closeShortPosition,
  getShortPositions,
} from "../controllers/shortController.js";
import isAuthenticated from "../middlewares/auth.js";

const router = express.Router();

// Per-route middleware rather than a blanket router.use, for the same reason as
// userRoute (review A-02) and so an unmatched path 404s instead of 401s.
router.route("/sell").post(isAuthenticated, executeShortSell);
router.route("/cover").post(isAuthenticated, closeShortPosition);
router.route("/positions").get(isAuthenticated, getShortPositions);

export default router;
