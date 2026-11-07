/**
 * Produces a coarse, display-friendly platform label ("Web", "Android",
 * "iOS", or null) for a sign-in attempt, WITHOUT ever persisting the raw
 * User-Agent string anywhere (SignInAttempt.platform only ever stores the
 * short label this function returns - see SignInAttempt.ts's privacy
 * note). Two sources, in priority order:
 *
 *   1. An explicit `platform` field in the login request body - sent by
 *      the Flutter mobile app (ApiService.inspectorLogin), which knows its
 *      own platform with certainty and doesn't need guessing.
 *   2. A coarse heuristic over the standard `User-Agent` request header -
 *      used for the admin web panel's login, which sends no explicit
 *      field (avoids needing to touch the protected Login.tsx file this
 *      session).
 *
 * Returns null (not "Unknown") when neither source yields a confident
 * label, so the UI can show "Not available" rather than a misleading
 * guess.
 */
export function detectPlatform(explicit: unknown, userAgentHeader: unknown): string | null {
    if (typeof explicit === "string" && explicit.trim()) {
        const normalized = explicit.trim();
        // Accept common client-declared values as-is (already short,
        // human-readable labels) rather than re-mapping them.
        return normalized.slice(0, 40);
    }

    const ua = typeof userAgentHeader === "string" ? userAgentHeader : "";
    if (!ua) return null;

    if (/Android/i.test(ua)) return "Android";
    if (/iPhone|iPad|iPod|iOS/i.test(ua)) return "iOS";
    if (/Windows|Macintosh|Linux|X11/i.test(ua) && /Mozilla/i.test(ua)) return "Web";
    return null;
}
