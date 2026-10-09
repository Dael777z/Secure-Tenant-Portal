export type AppErrorCode =
    | "EMAIL_IN_USE"
    | "INVALID_CREDENTIALS"
    | "INVALID_TOKEN"
    | "USER_NOT_FOUND"
    | "VALIDATION_ERROR"
    | "SIGNUP_NOT_ALLOWED"
    | "NO_ACTIVE_LEASE"
    | "NOT_FOUND"
    | "DATABASE_REQUIRED"
    | "PLAID_NOT_CONFIGURED"
    | "PLAID_ERROR"
    | "UNIT_OCCUPIED"
    | "TENANT_ON_LEASE"
    | "LEASE_HAS_PAYMENTS"
    | "NOT_OFFICE_PAYMENT"
    | "UNIT_HAS_LEASES"
    | "PROPERTY_HAS_LEASES"
    | "RECEIPT_INVALID"

export class AppError extends Error {
    constructor(public readonly code: AppErrorCode) {
        super(code)
        this.name = "AppError"
    }
}