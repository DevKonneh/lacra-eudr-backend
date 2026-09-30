import multer, { FileFilterCallback } from "multer";
import { Request } from "express";
import path from "path";

// Files are uploaded to Cloudinary (see utils/cloudUpload.ts) rather than
// Render's local disk, since Render's filesystem is ephemeral and wipes
// uploaded files on every restart/redeploy. Using memoryStorage keeps each
// file's raw bytes in `file.buffer` (instead of writing to `file.path` on
// disk), which controllers then stream up to Cloudinary.
//
// A per-file size cap prevents a single huge upload from ballooning memory
// usage, since files now live in RAM (however briefly) instead of disk.
const storage = multer.memoryStorage();

// ── Allowed MIME types ────────────────────────────────────────────────────────
// Only image formats and PDF documents are legitimate for this application
// (farmer photos, ID scans, land deeds, compliance docs).
// Executable types (.exe, .sh), server-side scripts (.php, .py, .js) and
// SVG (which can contain inline <script> tags and cause stored XSS) are
// explicitly excluded. The check covers both the MIME type reported by the
// browser AND the file extension as a second-factor guard against clients
// that spoof Content-Type headers.
const ALLOWED_MIME_TYPES = new Set([
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/heic",
    "image/heif",
    "application/pdf",
]);

const ALLOWED_EXTENSIONS = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".heic",
    ".heif",
    ".pdf",
]);

const fileFilter = (
    _req: Request,
    file: Express.Multer.File,
    cb: FileFilterCallback,
): void => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_MIME_TYPES.has(file.mimetype) && ALLOWED_EXTENSIONS.has(ext)) {
        cb(null, true);
    } else {
        // Pass an error; Multer will discard the file and forward the error
        // to Express's error-handler (errorHandler middleware). Casting is
        // required because @types/multer's FileFilterCallback uses Error|null.
        cb(new Error(
            `File type not allowed. Accepted types: JPEG, PNG, GIF, WebP, HEIC, PDF. Received: ${file.mimetype} (${ext || "no extension"})`
        ) as unknown as null, false);
    }
};

export const upload = multer({
    storage,
    limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per file
    fileFilter,
});
