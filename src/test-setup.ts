// Runs before every test file. Loads .env if there is one, then fills in what
// the code needs so `npm test` works on a fresh clone without a .env.
import { configDotenv } from "dotenv"

configDotenv({ quiet: true })
process.env.JWT_ACCESS_SECRET ||= "test-only-secret-not-used-anywhere-else"
// Tests hash many passwords; the cost factor does not change what is tested.
process.env.BCRYPT_ROUNDS = "4"
process.env.LOG_FILE_ENABLED = "0"
process.env.LOG_CONSOLE_ENABLED = "1"
