module.exports = {
    test: {
        include: ["src/**/*.test.ts"],
        exclude: ["dist/**", "node_modules/**"],
        // Loads .env and fills in test-only defaults (src/test-setup.ts).
        setupFiles: ["src/test-setup.ts"],
        // Integration tests sign in (bcrypt) and hit a real database; with every
        // file running at once, the 5 s default is too tight on a busy machine.
        testTimeout: 20000,
        hookTimeout: 30000,
    },
}
