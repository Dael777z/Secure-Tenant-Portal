export type AppErrorCode =
    | "EMAIL_IN_USE"
    | "INVALID_CREDENTIALS"
    | "INVALID_TOKEN"
    | "USER_NOT_FOUND"
    | "VALIDATION_ERROR"
    | "SIGNUP_NOT_ALLOWED"

export class AppError extends Error {
    constructor(public readonly code: AppErrorCode) {
        super(code)
        this.name = "AppError"
    }
}