import express from "express";
import {
  CreateUser,
  ExecuteOrder,
  getMyProfile,
  LoginUser,
  getMyPortfolio,
} from "../controllers/userController";
import isAuthenticated from "../middlewares/auth";

const router = express.Router();

// login routes
router.route("/signup").post(CreateUser);
router.route("/login").post(isAuthenticated, LoginUser);

router.use(isAuthenticated);

//profile routes
router.get("/me", getMyProfile);
router.get("/portfolio", getMyPortfolio);

// order execution route
router.route("/execute").post(ExecuteOrder);

export default router;
