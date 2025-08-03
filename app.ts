// import { createServer } from "http";
// import { Server } from "socket.io";
// import express from "express";
// import { config } from "dotenv";
// import cors from "cors";
// import { Cors } from "./src/interface/userInterface";
// import cookieParser from "cookie-parser";
// import errorMiddleware from "./src/middlewares/errorMiddleware";

// const app = express();
// // Load environment variables
// config({ path: "./src/config/config.env" });

// // defining all Environment Variables used in this component
// const client_Url =
//   process.env.CLIENT_URL || ("http://localhost:3000" as string);
// const cookie_expire = (process.env.COOKIE_EXPIRY || 3) as number;
// const ENV = process.env.NODE_ENV || "DEVELOPMENT";

// const corsOptions: Cors = {
//   origin: [client_Url],
//   methods: ["GET", "POST", "PUT", "DELETE"],
//   credentials: true,
// };

// const age = cookie_expire * 24 * 24 * 60 * 60 * 1000;

// // Cookies Option
// export let cookieOptions = {
//   maxAge: age,
//   httpOnly: true,
//   secure: process.env.NODE_ENV !== "DEVELOPMENT",
// };

// // Setting SameSite to None in Production
// // if (process.env.NODE_ENV !== "DEVELOPMENT") {
// //   corsOptions.sameSite = "None";
// //   cookieOptions = { ...cookieOptions, sameSite: "None" };
// // }

// // Declaring Third party Socket Connection

// let preDefinedQuery=[];
// let fixedData:any=[];

// let input_Query=[];

// // Creating Http Server
// const server = createServer(app);

// // Creating Socket Server
// const io = new Server(server);

// // Creating Socket Map and Set of Online User
// export const userSocketIDs = new Map();
// const onlineUsers = new Set();

// const FetchList = () => {
//   console.log(userSocketIDs);
//   console.log(onlineUsers);
// };

// io.on("connection", (socket) => {
//   //  const user = socket.user;
//   let user = { _id: "" };
//   FetchList();
//   // Remove old socket ID if the user was already connected
//   if (userSocketIDs.has(user._id.toString())) {
//     console.count(`User ${user._id} reconnected, replacing old socket.`);
//     userSocketIDs.delete(user._id);
//   }

//   userSocketIDs.set(user?._id.toString(), socket?.id);
//   onlineUsers.add(user?._id.toString());

//   // emiting Landing Page Data
//   socket.to(socket.id).emit("LandingPageData", fixedData);

//   socket.on("disconnect", () => {
//     console.log("User Disconnected");
//     userSocketIDs.delete(user?._id.toString());
//     onlineUsers.delete(user?._id.toString());
//   })
// });

// // Middlewares
// app.use(cors(corsOptions));
// app.use(express.json());
// app.use(cookieParser());
// app.use(errorMiddleware);
// export default server;

// ---------------------------- app.ts ----------------------------
// Relay server: one Binance WS in, many Socket.IO clients out.
// ◆ Keeps a single upstream WebSocket to Binance for *all* tracked symbols.
// ◆ Caches the latest tick per stream in Redis (snapshot).
// ◆ Publishes each tick on Redis Pub/Sub (horizontal scaling).
// ◆ Maintains an in‑memory **Top‑50 board** (depth mid‑price only).
// ◆ Every client automatically receives the board; portfolio symbols are optional.
//-----------------------------------------------------------------

// ——— imports ——————————————————————————————————————————————————————————
import { createServer } from "http";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "dotenv";
import { Server } from "socket.io";
import RedisPkg from "ioredis";
import WebSocket from "ws";
import jwt from "jsonwebtoken";
import errorMiddleware from "./src/middlewares/errorMiddleware.js";
import { TOP50 } from "./src/constants/StockList.js";
import userRoute from "./src/routes/userRoute.js";
// ——— env + constants ——————————————————————————————————————————————
config();

const PORT = Number(process.env.PORT) || 4000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const USD_INR = Number(process.env.USD_INR) || 86; // △ rupee fx

const BOARD = TOP50;
const BOARD_STREAM = BOARD.map((s) => `${s.toLowerCase()}@ticker`).join("/");
const Redis: any = (RedisPkg as any).default || RedisPkg;
// ——— express / socket.io ——————————————————————————————————————————
const app = express();
app.use("/api/v1/", userRoute);
const server = createServer(app);
app.use(cors({ origin: [CLIENT_URL], credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(errorMiddleware);
// app.get("/health", (_req, res) => res.send("ok"));

const io = new Server(server, {
  cors: { origin: [CLIENT_URL], credentials: true },
});

// ——— redis ————————————————————————————————————————————————————————
const rCmd = new Redis(REDIS_URL);
const rSub = new Redis(REDIS_URL);

// ——— board cache helper ————————————————————————————————————————
type Row = {
  name: string;
  price: number; // USD
  priceInr: number; // △ INR
  change: number; // USD
  changeInr: number; // △ INR
  pct: number; // %
  ts: number;
};

const boardCache: Record<string, Row> = {};
const boardSnapshot = () => BOARD.map((s) => boardCache[s]).filter(Boolean);

// ——— binance upstream ————————————————————————————————————————————
const upstream = new WebSocket(
  `wss://fstream.binance.com/stream?streams=${BOARD_STREAM}`
);

function normaliseTicker(t: any): Row {
  const priceUsd = +t.c;
  const changeUsd = +t.p;

  return {
    name: `${t.s}-ticker`,
    price: priceUsd,
    priceInr: +(priceUsd * USD_INR).toFixed(2), // △ convert
    change: changeUsd,
    changeInr: +(changeUsd * USD_INR).toFixed(2), // △ convert
    pct: +t.P,
    ts: Date.now(),
  };
}

const liveUpstream = new Set<string>(BOARD);
function subscribeUpstream(symbols: string[]) {
  const params = symbols
    .filter((sym) => !liveUpstream.has(sym))
    .map((sym) => `${sym.toLowerCase()}@ticker`);
  if (!params.length) return;
  upstream.send(
    JSON.stringify({ method: "SUBSCRIBE", params, id: Date.now() })
  );
  params.forEach((p) => liveUpstream.add(p.split("@")[0].toUpperCase()));
}

upstream.on("message", async (buf) => {
  const { data } = JSON.parse(buf.toString());
  const row = normaliseTicker(data);

  await rCmd
    .pipeline()
    .set(`tick:${row.name}`, JSON.stringify(row))
    .publish(`tick.${row.name}`, JSON.stringify(row))
    .exec();
});

// ——— redis → socket.io bridge ————————————————————————————————
rSub.psubscribe("tick.*");
rSub.on("pmessage", (_p:string, _c:string, raw:string) => {
  const row: Row = JSON.parse(raw);
  const sym = row.name.split("-")[0];

  io.to(row.name).emit("tick", row);
  if (BOARD.includes(sym)) {
    boardCache[sym] = row;
    io.to("top50").emit("board", boardSnapshot());
  }
});

// ——— online-user counts (optional log) ————————————————————————
const userSockets = new Map<string, string>();
const guestSockets = new Set<string>();
setInterval(
  () =>
    console.table({
      time: new Date().toLocaleTimeString(),
      users: userSockets.size,
      guests: guestSockets.size,
    }),
  60_000
);

// ——— auth middleware ——————————————————————————————————————————
io.use((sock, next) => {
  const token = sock.handshake.auth?.token;
  if (token) {
    try {
      sock.data.userId = String((jwt.verify(token, JWT_SECRET) as any).userId);
    } catch {}
  }
  next();
});

// ——— connection handler ————————————————————————————————————————
io.on("connection", async (sock) => {
  const uid = sock.data.userId as string | undefined;
  if (uid) {
    if (userSockets.has(uid))
      io.sockets.sockets.get(userSockets.get(uid)!)?.disconnect();
    userSockets.set(uid, sock.id);
  } else guestSockets.add(sock.id);

  sock.join("top50");
  sock.emit("board", boardSnapshot());

  if (uid) {
    const symbols = await getPortfolioSymbols(uid); // db query
    const rooms = symbols.map((s) => `${s}-ticker`);
    rooms.forEach((r) => sock.join(r));

    subscribeUpstream(symbols);
    const raws = await rCmd.mget(rooms.map((r) => `tick:${r}`));
    raws.forEach((r:string|null) => r && sock.emit("tick", JSON.parse(r)));
  }

  sock.on("subscribePortfolio", () => sock.emit("error", "AUTH_REQUIRED"));
  sock.on("disconnect", () => {
    if (uid) userSockets.delete(uid);
    else guestSockets.delete(sock.id);
  });
});

// ——— db stub (replace with real query) ————————————————————————
async function getPortfolioSymbols(userId: string): Promise<string[]> {
  return []; // TODO: fetch ["SOLUSDT", "XRPUSDT", ...]
}

// ——— boot server ——————————————————————————————————————————————
server.listen(PORT, () =>
  console.log(`Relay ready on http://localhost:${PORT}  •  ₹ rate=${USD_INR}`)
);
