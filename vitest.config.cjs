module.exports = {
    test: {
        include: ["src/**/*.test.ts"],
        exclude: ["dist/**", "node_modules/**"],
        // Loads .env and fills in test-only defaults (src/test-setup.ts).
        setupFiles: ["src/test-setup.ts"],
    },
}
