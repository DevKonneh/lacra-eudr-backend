import { v2 as cloudinary } from "cloudinary";

// Cloudinary is used for ALL file storage (farmer photos, ID photos,
// signatures, farm photos, and EUDR boundary-evidence photos) instead of
// Render's local disk. Render's filesystem is ephemeral — any file written
// to disk is wiped every time the service restarts (redeploy, crash, or
// scale-to-zero on idle), which was silently deleting uploaded photos.
// Cloudinary storage is fully decoupled from the hosting platform, so files
// survive restarts/redeploys indefinitely.
//
// Config is read from CLOUDINARY_URL (format:
// cloudinary://<api_key>:<api_secret>@<cloud_name>) if present, otherwise
// from the three discrete CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY /
// CLOUDINARY_API_SECRET env vars. The Cloudinary SDK auto-reads
// CLOUDINARY_URL from process.env, so calling .config() with no args is
// enough in that case — but we still call it explicitly with discrete vars
// as a fallback for clarity/robustness across different Render env setups.
if (process.env.CLOUDINARY_URL) {
    cloudinary.config(true); // reads CLOUDINARY_URL from env automatically
} else {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
        secure: true,
    });
}

export default cloudinary;
