/**
 * Every error the API answers with, and its HTTP status. Throw
 * `new AppError("NOT_FOUND")` anywhere; middleware/errors.ts sends
 * `{ error: "NOT_FOUND" }` with the status below.
 */
export const ERROR_STATUS = {
    // sign-in and sessions
    UNAUTHENTICATED: 401,
    INVALID_CREDENTIALS: 401,
    INVALID_TOKEN: 401,
    SIGNUP_NOT_ALLOWED: 403,
    MFA_NOT_SUPPORTED: 403,
    FORBIDDEN: 403,
    // bad input / missing things
    VALIDATION_ERROR: 400,
    RECEIPT_INVALID: 400,
    NOT_FOUND: 404,
    NO_ACTIVE_LEASE: 404,
    // conflicts with what is on record
    EMAIL_IN_USE: 409,
    UNIT_OCCUPIED: 409,
    UNIT_INACTIVE: 409,
    TENANT_ON_LEASE: 409,
    TENANT_ALREADY_SIGNED_UP: 409,
    TENANT_NOT_SIGNED_UP: 409,
    UNIT_HAS_LEASES: 409,
    PROPERTY_HAS_LEASES: 409,
    NOT_OFFICE_PAYMENT: 409,
    PAYMENT_ALREADY_REVERSED: 409,
    // tenant payments: at least the balance, at most PREPAY_MONTHS of rent ahead; one report at a time
    AMOUNT_BELOW_BALANCE: 409,
    AMOUNT_ABOVE_LIMIT: 409,
    ALREADY_REPORTED: 409,
    METHOD_NOT_AVAILABLE: 409,
    // missing on this server
    PLAID_NOT_CONFIGURED: 503,
    PLAID_ERROR: 502,
    RATE_LIMITED: 429,
    // a password that is long enough but among the first an attacker would try
    PASSWORD_TOO_COMMON: 400,
    // a request body bigger than the server accepts
    PAYLOAD_TOO_LARGE: 413,
} as const

export type AppErrorCode = keyof typeof ERROR_STATUS

export class AppError extends Error {
    /** `details` is sent to the client beside the code (keep secrets out of it). */
    constructor(public readonly code: AppErrorCode, public readonly details?: Record<string, unknown>) {
        super(code)
        this.name = "AppError"
    }
}
