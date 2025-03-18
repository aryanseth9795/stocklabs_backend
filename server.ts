import app from "./app";
import { config } from "dotenv";




// Load environment variables
config({ path: "./src/config/config.env" });









// listen to port     
app.listen(process.env.PORT, () => {
  console.log("Server is running on http://localhost:3000");
});
