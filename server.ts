import app from "./app.js";
import dbConnect from "./src/db/db.js";
import errorMiddleware from "./src/middlewares/errorMiddleware.js";




// connect to database
if (!process.env.MONGO_URI) {
  throw new Error("MONGO_URI is not defined in environment variables");
}
dbConnect(process.env.MONGO_URI);






//Error Middleware
app.use(errorMiddleware);

// Listen to port
app.listen(process.env.PORT || 5000, () => {
  console.log(`Server is running on port ${process.env.PORT}`);
});
