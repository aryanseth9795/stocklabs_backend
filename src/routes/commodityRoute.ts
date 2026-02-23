import express from "express";
import {
  streamCommodityPrices,
  executeCommodityOrder,
  getCommodityPortfolio,
} from "../controllers/commodityController.js";
import isAuthenticated from "../middlewares/auth.js";

const router = express.Router();

// SSE stream – public (guests can see prices)
router.route("/stream").get(streamCommodityPrices);

// Authenticated routes
router.use(isAuthenticated);
router.route("/execute").post(executeCommodityOrder);
router.route("/portfolio").get(getCommodityPortfolio);

export default router;
