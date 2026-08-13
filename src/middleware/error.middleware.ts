import { Request, Response, NextFunction } from "express";
import { errorResponse } from "../utils/response";

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
    console.error("Global Error:", err);
    return errorResponse(res, "Internal Server Error", [err.message || "Unknown error"], 500);
};
