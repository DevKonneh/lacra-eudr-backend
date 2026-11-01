/**
 * Small, dependency-free string-similarity helper used by the Cooperative
 * Registry's duplicate-detection scan (see CooperativeController#scan).
 * Deliberately simple (normalized Levenshtein ratio) — this only needs to
 * surface *candidates* for a human reviewer, never to auto-merge anything,
 * so a lightweight heuristic is sufficient.
 */

function levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    const prev = new Array(n + 1);
    const curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                prev[j] + 1,      // deletion
                curr[j - 1] + 1,  // insertion
                prev[j - 1] + cost // substitution
            );
        }
        for (let j = 0; j <= n; j++) prev[j] = curr[j];
    }
    return prev[n];
}

// Strips punctuation/extra whitespace and upper-cases, so "KWAKERSEH
// COCOA FARMERS' COOPERATIVE SOCIETY" and "Kwakerseh Cocoa Farmers
// Cooperative Society" compare as effectively identical.
export function normaliseForComparison(value: string): string {
    return value
        .toUpperCase()
        .replace(/['".,]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** Returns a similarity ratio in [0, 1] — 1 means identical. */
export function similarityRatio(a: string, b: string): number {
    const na = normaliseForComparison(a);
    const nb = normaliseForComparison(b);
    if (na === nb) return 1;
    const maxLen = Math.max(na.length, nb.length);
    if (maxLen === 0) return 1;
    const distance = levenshteinDistance(na, nb);
    return 1 - distance / maxLen;
}
