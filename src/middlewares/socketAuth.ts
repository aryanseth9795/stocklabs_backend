
// import ErrorHandler from "../middlewares/ErrorHandler.js";
// import { NextFunction } from "express";
// import jwt, { decode } from "jsonwebtoken";

// export const socketAuthenticator = async (err:ErrorHandler, socket, next:NextFunction) => {
//   try {
//     if (err) return next(err);

//     const authToken = socket.request.cookies["token"];

//     if (!authToken)
//       return next(new ErrorHandler("Please login to access this route", 401));

//     const decodedData= jwt.verify(authToken, process.env.JWT_SECRET!);

//     const user = await User.findById(decodedData?.id);

//     if (!user) {
//       return next(new ErrorHandler("Please login to access this route", 401));
//     }

//     socket.user = user;
//     return next();
//   } catch (error) {
//     console.log(error);
//     return next(new ErrorHandler("Please login to access this route", 401));
//   }
// };