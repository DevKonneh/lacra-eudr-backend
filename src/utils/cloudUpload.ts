import streamifier from "streamifier";
import cloudinary from "../config/cloudinary";
import { UploadApiResponse } from "cloudinary";

// The LACRA Cloudinary folder all app uploads live under, so they're easy to
// find/manage in the Cloudinary dashboard separate from any other project
// that might reuse this same Cloudinary account.
const CLOUDINARY_FOLDER = "lacra-eudr";

/**
 * Uploads a single in-memory file buffer (from Multer's memoryStorage) to
 * Cloudinary and resolves with the full upload result (most importantly
 * `secure_url`, the permanent public HTTPS URL to store in the DB).
 *
 * resource_type: "auto" lets Cloudinary correctly handle both images and any
 * non-image documents (e.g. PDFs) uploaded through the same generic
 * upload.any() multer middleware.
 */
export const uploadBufferToCloudinary = (
    buffer: Buffer,
    originalName?: string
): Promise<UploadApiResponse> => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: CLOUDINARY_FOLDER,
                resource_type: "auto",
                filename_override: originalName,
                use_filename: true,
                unique_filename: true,
            },
            (error, result) => {
                if (error || !result) {
                    return reject(error || new Error("Cloudinary upload failed with no result"));
                }
                resolve(result);
            }
        );
        streamifier.createReadStream(buffer).pipe(uploadStream);
    });
};

/**
 * Uploads a Multer file object (memoryStorage — has `.buffer`, not `.path`)
 * and returns just its permanent Cloudinary URL string.
 */
export const uploadFileToCloudinary = async (
    file: Express.Multer.File
): Promise<string> => {
    const result = await uploadBufferToCloudinary(file.buffer, file.originalname);
    return result.secure_url;
};

/**
 * Uploads multiple Multer file objects in parallel and returns their
 * permanent Cloudinary URLs, in the same order as the input array.
 */
export const uploadFilesToCloudinary = async (
    files: Express.Multer.File[]
): Promise<string[]> => {
    const results = await Promise.all(files.map((f) => uploadFileToCloudinary(f)));
    return results;
};
