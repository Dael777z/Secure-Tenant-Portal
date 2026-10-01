import { configDotenv } from "dotenv"

configDotenv()

function required(name: string): string {
    const value = process.env[name]?.trim()
    if (!value) throw new Error(`Missing required environment variable: ${name}`)
    return value
}

function positiveInteger(name: string, fallback?: number): number {
    const raw = process.env[name] ?? (fallback === undefined ? undefined : String(fallback))
    const value = Number(raw)
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`)
    }
    return value
}

function booleanValue(name: string, fallback: boolean): boolean {
    const raw = process.env[name]?.trim().toLowerCase()
    if (raw === undefined) return fallback
    if (["1", "true", "yes"].includes(raw)) return true
    if (["0", "false", "no"].includes(raw)) return false
    throw new Error(`${name} must be a boolean value`)
}

export const env = {
    port: positiveInteger("PORT", 3000),
    webOrigin: process.env.WEB_ORIGIN?.trim() || "http://localhost:5173",
    secureCookies: booleanValue("SECURE_COOKIES", false),
    accessSecret: required("JWT_ACCESS_SECRET"),
    accessTtlSeconds: positiveInteger("JWT_ACCESS_TTL", 900),
    refreshTtlMilliseconds: positiveInteger("REFRESH_TTL", 604800000),
    bcryptRounds: positiveInteger("BCRYPT_ROUNDS", 12),
    devMode: booleanValue("DEV", true),
    serviceName: process.env.SERVICE_NAME?.trim() || "portal",
    logConsoleEnabled: booleanValue("LOG_CONSOLE_ENABLED", true),
    logFileEnabled: booleanValue("LOG_FILE_ENABLED", true),
    logFilePath: process.env.LOG_FILE_PATH?.trim() || "logs/application.jsonl",
}