import express from "express";
import {
  streamCommodityPrices,
  executeCommodityOrder,
  getCommodityPortfolio,
} from "../controllers/commodityController.js";
import isAuthenticated from "../middlewares/auth.js";

const router = express.Router();

// SSE stream – public (guests can see prices).
// This genuinely is public now: userRoute's blanket `router.use(isAuthenticated)`
// used to intercept it before this router was reached (review A-02).
router.route("/stream").get(streamCommodityPrices);

// Authenticated routes — per-route middleware, so an unmatched path under this
// mount returns 404 rather than a misleading 401.
router.route("/execute").post(isAuthenticated, executeCommodityOrder);
router.route("/portfolio").get(isAuthenticated, getCommodityPortfolio);

export default router;
