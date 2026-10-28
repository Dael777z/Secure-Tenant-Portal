// Runs before every test file. vitest sets NODE_ENV=test, which config.ts
// turns into fast password hashing, loose rate limits and quiet logs.
// Integration tests also need TEST_DATABASE_URL (see src/integration/helpers.ts).
import { configDotenv } from "dotenv"

configDotenv({ quiet: true })
