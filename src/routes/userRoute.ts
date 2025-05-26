
import express from "express";
import { getMyProfile } from "../controllers/userController";



const router=express.Router();

router.route("/me").get(getMyProfile);


