import { Request, Response, NextFunction } from "express";
import { errorResponse } from "../utils/response";

export const errorHandler = (err: any, req: Request, res: Response, next: NextFunction) => {
    // Log the full error server-side for debugging — never echo err.message
    // to clients in production as it can leak implementation details,
    // stack traces, SQL error text, or file paths.
    console.error("Global Error:", err);

    // Multer file-type rejections should surface as 400 Bad Request,
    // not a generic 500, so clients know to fix their upload.
    if (err?.code === "LIMIT_FILE_SIZE") {
        return errorResponse(res, "File too large. Maximum size is 15 MB per file.", [], 400);
    }
    if (err instanceof Error && err.message?.startsWith("File type not allowed")) {
        return errorResponse(res, err.message, [], 400);
    }

    return errorResponse(res, "Internal Server Error", [], 500);
};
