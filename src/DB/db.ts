import mongoose from "mongoose";

const dbConnect = async (URL: string): Promise<void> => {
  try {
    const db = await mongoose.connect(URL);
    console.log("Database Connected to " + db.connection.host);
  } catch (error) {
    console.log(error);
    process.exit(1);
  }
};

export default dbConnect;
