import { createServer } from "http";
import { Server } from "socket.io";
import express from "express";
import { config } from "dotenv";
import { configData } from "./src/config/config";
import cors from "cors";
import { Cors } from "./src/interface/userInterface";
import cookieParser from "cookie-parser";

const app = express();
// Load environment variables
config({ path: "./src/config/config.env" });

const corsOptions: Cors = {
  origin: ["https://chatsup.aryanseth.in", configData.CLIENT_URL],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true,
};

const age: number =
  Number(configData.COOKIE_EXPIRY) * 24 * 60 * 60 * 1000 || 3 * 24 * 60 * 60 * 1000;
// Cookies Option
export let cookieOptions = {
  maxAge: age,
  httpOnly: true,
  secure: process.env.NODE_ENV !== "DEVELOPMENT",
};

// Setting SameSite to None in Production
// if (process.env.NODE_ENV !== "DEVELOPMENT") {
//   corsOptions.sameSite = "None";
//   cookieOptions = { ...cookieOptions, sameSite: "None" };
// }
const server = createServer(app);

const io = new Server(server);



// Creating Socket Map and Set of Online User
export const userSocketIDs = new Map();
const onlineUsers = new Set();
const FetchList = () => {
  console.log(userSocketIDs);
  console.log(onlineUsers);
};

io.on("connection",(socket)=>{
  //  const user = socket.user;
  let user={_id:""};
  FetchList();
  // Remove old socket ID if the user was already connected
  if (userSocketIDs.has(user._id.toString())) {
    console.count(`User ${user._id} reconnected, replacing old socket.`);
    userSocketIDs.delete(user._id);
  }

  userSocketIDs.set(user?._id.toString(), socket?.id);
  onlineUsers.add(user?._id.toString());


})

// Middlewares
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

export default app;
