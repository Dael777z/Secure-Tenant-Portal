export type AppErrorCode =
    | "EMAIL_IN_USE"
    | "INVALID_CREDENTIALS"
    | "INVALID_TOKEN"
    | "USER_NOT_FOUND"
    | "VALIDATION_ERROR"

export class AppError extends Error {
    constructor(public readonly code: AppErrorCode) {
        super(code)
        this.name = "AppError"
    }
}