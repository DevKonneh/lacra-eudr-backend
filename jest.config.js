/** @type {import('jest').Config} */
module.exports = {
    preset: "ts-jest",
    testEnvironment: "node",
    rootDir: ".",
    testMatch: ["<rootDir>/src/**/__tests__/**/*.test.ts"],
    verbose: true,
    // GeometryValidationService's constructor grabs a TypeORM repository from
    // AppDataSource at instantiation time; tests either use skipOverlapCheck
    // (no DB access needed) or mock the repository directly, so we don't
    // need a real DB connection for these tests. forceExit avoids Jest
    // hanging on any stray open handle from importing data-source.ts.
    forceExit: true,
    testTimeout: 20000,
};
