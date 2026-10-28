// One Vitest config for every test. Run a slice with --project:
//   npm run test:unit          unit tests only, no database
//   npm run test:integration   integration tests (need TEST_DATABASE_URL; `npm test` sets it up)
//   npm run test:coverage      everything, with a coverage report in coverage/
// Plain `vitest run` / `npm test` runs both projects.
module.exports = {
    test: {
        // Loads .env and fills in test-only defaults (src/test-setup.ts).
        setupFiles: ["src/test-setup.ts"],
        // Integration tests sign in (bcrypt) and hit a real database; with every
        // file running at once, the 5 s default is too tight on a busy machine.
        testTimeout: 20000,
        hookTimeout: 30000,
        projects: [
            {
                extends: true,
                test: {
                    name: "unit",
                    include: ["src/**/*.test.ts"],
                    exclude: ["dist/**", "node_modules/**", "src/integration/**"],
                },
            },
            {
                extends: true,
                test: {
                    name: "integration",
                    include: ["src/integration/**/*.integration.test.ts"],
                    exclude: ["dist/**", "node_modules/**"],
                },
            },
        ],
        coverage: {
            provider: "v8",
            // Server code only. Pure type files, the CLI/entry points and the tests themselves are left out.
            include: ["src/**/*.ts"],
            exclude: ["src/**/*.test.ts", "src/integration/**", "src/types/**", "src/test-setup.ts", "src/cli.ts", "src/app.ts"],
            reporter: ["text-summary", "json-summary", "lcov", "html"],
            reportsDirectory: "coverage",
            reportOnFailure: true,
            // Floors just under today's numbers, so coverage can rise but not quietly slide.
            // Raise them when the suite improves; never lower them to make a build pass.
            thresholds: { lines: 97, statements: 96, functions: 97, branches: 86 },
        },
    },
}
