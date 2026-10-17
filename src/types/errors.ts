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
    // missing on this server
    PLAID_NOT_CONFIGURED: 503,
    PLAID_ERROR: 502,
    RATE_LIMITED: 429,
} as const

export type AppErrorCode = keyof typeof ERROR_STATUS

export class AppError extends Error {
    constructor(public readonly code: AppErrorCode) {
        super(code)
        this.name = "AppError"
    }
}
