import path from "path";

/**
 * Converts a Multer file's absolute disk path into a public, web-accessible URL
 * relative to the API root (e.g. "/uploads/farmerPhoto-12345.jpg").
 *
 * Files are served statically from `/uploads` (see index.ts), so the frontend
 * can resolve this path against the API base URL to display images.
 */
export const toPublicFileUrl = (filePath?: string | null): string | undefined => {
    if (!filePath) return undefined;
    const filename = path.basename(filePath);
    return `/uploads/${filename}`;
};

export const toPublicFileUrls = (filePaths?: (string | undefined)[] | null): string[] => {
    if (!filePaths) return [];
    return filePaths
        .filter((p): p is string => !!p)
        .map((p) => toPublicFileUrl(p)!)
        .filter((u): u is string => !!u);
};
