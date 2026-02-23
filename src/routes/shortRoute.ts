import express from "express";
import {
  executeShortSell,
  closeShortPosition,
  getShortPositions,
} from "../controllers/shortController.js";
import isAuthenticated from "../middlewares/auth.js";

const router = express.Router();
router.use(isAuthenticated);

router.route("/sell").post(executeShortSell);
router.route("/cover").post(closeShortPosition);
router.route("/positions").get(getShortPositions);

export default router;
