import express from "express";
import {
  CreateUser,
  ExecuteOrder,
  getMyProfile,
  LoginUser,
  getMyPortfolio,
  check,
} from "../controllers/userController.js";
import isAuthenticated from "../middlewares/auth.js";

const router = express.Router();

// login routes
router.route("/signup").post(CreateUser);
router.route("/login").post(LoginUser);
router.route("/check").get(check);

router.use(isAuthenticated);

//profile routes
router.get("/me", getMyProfile);
router.get("/portfolio", getMyPortfolio);

// order execution route
router.route("/execute").post(ExecuteOrder);

export default router;
