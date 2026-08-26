import multer from "multer";

// Files are uploaded to Cloudinary (see utils/cloudUpload.ts) rather than
// Render's local disk, since Render's filesystem is ephemeral and wipes
// uploaded files on every restart/redeploy. Using memoryStorage keeps each
// file's raw bytes in `file.buffer` (instead of writing to `file.path` on
// disk), which controllers then stream up to Cloudinary.
//
// A per-file size cap prevents a single huge upload from ballooning memory
// usage, since files now live in RAM (however briefly) instead of disk.
const storage = multer.memoryStorage();

export const upload = multer({
    storage,
    limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per file
});
