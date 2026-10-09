import { AsyncLocalStorage } from "async_hooks"

export interface LogContext {
    request_id?: string
    flow_id?: string
    user_id?: string
}

const storage = new AsyncLocalStorage<LogContext>()

export function runWithLogContext<T>(context: LogContext, callback: () => T): T {
    return storage.run(context, callback)
}

export function getLogContext(): LogContext {
    return storage.getStore() ?? {}
}

export function updateLogContext(values: LogContext): void {
    const context = storage.getStore()
    if (context) Object.assign(context, values)
}

export function runWithAdditionalLogContext<T>(values: LogContext, callback: () => T): T {
    return storage.run({ ...getLogContext(), ...values }, callback)
}
