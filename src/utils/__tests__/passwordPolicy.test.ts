import { validatePassword, isPasswordValid } from "../passwordPolicy";

describe("passwordPolicy", () => {
    describe("validatePassword", () => {
        it("rejects an empty/missing password", () => {
            expect(validatePassword("").valid).toBe(false);
            expect(validatePassword(undefined).valid).toBe(false);
            expect(validatePassword(null).valid).toBe(false);
        });

        it("rejects a password shorter than 8 characters", () => {
            const result = validatePassword("Ab1!");
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.includes("8 characters"))).toBe(true);
        });

        it("rejects a password with no uppercase letter", () => {
            const result = validatePassword("lowercase1!");
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.includes("uppercase"))).toBe(true);
        });

        it("rejects a password with no lowercase letter", () => {
            const result = validatePassword("UPPERCASE1!");
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.includes("lowercase"))).toBe(true);
        });

        it("rejects a password with no digit", () => {
            const result = validatePassword("NoDigitsHere!");
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.includes("number"))).toBe(true);
        });

        it("rejects a password with no special character", () => {
            const result = validatePassword("NoSpecial123");
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.includes("special character"))).toBe(true);
        });

        it("rejects a common/trivial password even if it satisfies composition rules", () => {
            const result = validatePassword("Password1!");
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.includes("too common"))).toBe(true);
        });

        it("returns ALL violated rules at once, not just the first", () => {
            const result = validatePassword("abc");
            expect(result.valid).toBe(false);
            // too short, no uppercase, no digit, no special char - at least 4 errors
            expect(result.errors.length).toBeGreaterThanOrEqual(4);
        });

        it("accepts a password satisfying every rule", () => {
            const result = validatePassword("Gb@rnga2024!");
            expect(result.valid).toBe(true);
            expect(result.errors).toEqual([]);
        });
    });

    describe("isPasswordValid", () => {
        it("is a boolean-returning convenience wrapper", () => {
            expect(isPasswordValid("Gb@rnga2024!")).toBe(true);
            expect(isPasswordValid("weak")).toBe(false);
        });
    });
});
