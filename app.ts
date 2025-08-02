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

import { createServer } from "http";               // Shared HTTP+WS port
import express from "express";                     // REST / health‑check
import { config } from "dotenv";                   // Environment variables for dev/prod secrets
import cors from "cors";                           // Cross‑origin for React front‑end
import cookieParser from "cookie-parser";          // Session cookies (future auth)
import { Server } from "socket.io";                // Downstream WS multiplexing
import Redis from "ioredis";                       // Redis commands + pub/sub
import WebSocket from "ws";                        // Upstream Binance WS client
import errorMiddleware from "./src/middlewares/errorMiddleware";
import { TOP50 } from "./src/constants/StockList";     // <<< fixed Top‑50 symbols (uppercase) picked by market‑cap


//-----------------------------------------------------------------
// 1️⃣  Configuration ------------------------------------------------
//-----------------------------------------------------------------
config({ path: "./src/config/config.env" });        // Loads .env if present (e.g. REDIS_URL)

const PORT       = Number(process.env.PORT) || 4000;
const REDIS_URL  = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

// The board is now locked to the symbols imported from TOP50.ts
const BOARD_SYMBOLS = TOP50;                        // Already uppercase array like ["BTCUSDT", "ETHUSDT", …]

//-----------------------------------------------------------------
// 2️⃣  Express + Socket.IO bootstrap --------------------------------
//-----------------------------------------------------------------
const app    = express();
const server = createServer(app);
const io     = new Server(server, {
  cors: { origin: [CLIENT_URL], credentials: true }
});

//-----------------------------------------------------------------
// 3️⃣  Redis connections -------------------------------------------
//-----------------------------------------------------------------
const redisCmd = new Redis(REDIS_URL);     // commands
const redisSub = new Redis(REDIS_URL);     // dedicated SUB connection

//-----------------------------------------------------------------
// 4️⃣  In‑memory board cache ---------------------------------------
//-----------------------------------------------------------------
// key = SYMBOL, value = { name, currentPrice, ts }
const boardCache: Record<string, { name: string; currentPrice: number; ts: number }> = {};
const boardSnapshot = () => BOARD_SYMBOLS.map(s => boardCache[s]).filter(Boolean);

//-----------------------------------------------------------------
// 5️⃣  Upstream Binance WebSocket ----------------------------------
//-----------------------------------------------------------------
// Build combined‑stream query from *all* board symbols (lowercase for API)
const streamQuery = BOARD_SYMBOLS.map(s => `${s.toLowerCase()}@aggTrade/${s.toLowerCase()}@depth`).join("/");
const binanceWS   = new WebSocket(`wss://fstream.binance.com/stream?streams=${streamQuery}`);

function normalise(stream: string, data: any) {
  const [symbol] = stream.split("@");              // e.g. btcusdt
  const upper = symbol.toUpperCase();
  if (data.e === "aggTrade") {
    return { name: `${upper}-aggTrade`, currentPrice: +data.p, ts: Date.now() };
  }
  if (data.e === "depthUpdate") {
    const bid = +data.b[0][0];
    const ask = +data.a[0][0];
    return { name: `${upper}-depth`, currentPrice: (bid + ask) / 2, ts: Date.now() };
  }
  return null;                                     // ignore other event types
}

binanceWS.on("message", async (buf) => {
  const { stream, data } = JSON.parse(buf.toString());
  const tick = normalise(stream, data);
  if (!tick) return;

  await redisCmd.pipeline()
    .set(`tick:${tick.name}`, JSON.stringify(tick))  // snapshot for late joiners
    .publish(`tick.${tick.name}`, JSON.stringify(tick)) // pub/sub fan‑out
    .exec();
});

//-----------------------------------------------------------------
// 6️⃣  Redis Pub/Sub → Socket.IO rooms + board maintenance ----------
//-----------------------------------------------------------------
redisSub.psubscribe("tick.*");
redisSub.on("pmessage", (_p, _chan, message) => {
  const tick = JSON.parse(message);
  const room = tick.name;                      // per‑stream room
  io.to(room).emit("tick", tick);             // personal portfolios

  const baseSym = tick.name.split("-")[0];     // e.g. BTCUSDT
  if (BOARD_SYMBOLS.includes(baseSym)) {       // board update path
    boardCache[baseSym] = tick;
    io.to("top50").emit("board", boardSnapshot());
  }
});

//-----------------------------------------------------------------
// 7️⃣  Socket.IO connection logic -----------------------------------
//-----------------------------------------------------------------
io.on("connection", async (socket) => {
  // Everyone automatically receives the Top‑50 board
  socket.join("top50");
  socket.emit("board", boardSnapshot());

  /* Personal subscribe: client sends { symbols:["SOLUSDT-depth", …] } */
  socket.on("subscribe", async ({ symbols = [] }) => {
    symbols.forEach(sym => socket.join(sym));         // join individual rooms

    if (symbols.length) {                             // send snapshots immediately
      const keys = symbols.map(s => `tick:${s}`);
      const raws = await redisCmd.mget(keys);
      raws.filter(Boolean).forEach(raw => socket.emit("tick", JSON.parse(raw!)));
    }
  });
});

//-----------------------------------------------------------------
// 8️⃣  Express middlewares & health route ---------------------------
//-----------------------------------------------------------------
app.use(cors({ origin: [CLIENT_URL], credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(errorMiddleware);


//-----------------------------------------------------------------
// 9️⃣  Start server --------------------------------------------------
//-----------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`Relay listening on http://localhost:${PORT}`);
});
//----------------------------------------------------------------------------------------------------------------------------------
