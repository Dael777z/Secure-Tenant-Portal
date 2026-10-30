module.exports = {
    test: {
        include: ["src/**/*.test.ts"],
        exclude: ["dist/**", "node_modules/**"],
        // Loads .env and fills in test-only defaults (src/test-setup.ts).
        setupFiles: ["src/test-setup.ts"],
        // Each integration file creates and drops its own database, and files run in parallel against
        // one Postgres: CREATE/DROP DATABASE queue behind each other, so give them room.
        testTimeout: 20_000,
        hookTimeout: 60_000,
    },
}
