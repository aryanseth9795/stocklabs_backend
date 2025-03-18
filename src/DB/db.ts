import mongoose from "mongoose";

const dbConnect = async (): Promise<void> => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not defined in environment variables");
  }
  try {
    const db = await mongoose.connect(process.env.MONGO_URI);
    console.log("Database Connected to " + db.connection.host);
  } catch (error) {
    console.log(error);
    process.exit(1);
  }
};

export default dbConnect;
