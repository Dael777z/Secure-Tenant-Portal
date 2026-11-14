import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { Application } from "express"

import { PASSWORDS } from "../db/seed/data"

/** Shared by the HTTP-level integration tests: a tiny cookie-keeping browser and the sample logins. */

/** Sample logins from the "clean" and full seed data. */
export const ACCOUNTS = {
    tenant: { email: "tenant@example.com", password: PASSWORDS.tenant },
    admin: { email: "manager@example.com", password: PASSWORDS.staff },
    maintenance: { email: "maintenance@example.com", password: PASSWORDS.staff },
}

export interface Reply {
    status: number
    body: any
    headers: Headers
    bytes: Buffer
}

/** Keeps cookies between calls, like a browser. `cookie` and `headers` let a test send its own. */
export class Client {
    private cookies = new Map<string, string>()
    constructor(private readonly host: string, private readonly appOrigin: string) {}

    cookie(name: string): string | undefined { return this.cookies.get(name) }

    async call(method: string, path: string, opts: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
        const res = await fetch(`${this.host}${path}`, {
            method,
            headers: {
                ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
                ...(method === "GET" ? {} : { origin: this.appOrigin }),
                cookie: opts.cookie ?? [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
                ...opts.headers,
            },
            body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
        })
        for (const line of res.headers.getSetCookie()) {
            const [pair] = line.split(";")
            const [name, value] = pair!.split("=")
            if (value) this.cookies.set(name!, value)
            else this.cookies.delete(name!)
        }
        const bytes = Buffer.from(await res.arrayBuffer())
        const text = bytes.toString("utf8")
        let body: any = {}
        try { body = text ? JSON.parse(text) : {} } catch { body = { raw: text } }
        return { status: res.status, body, headers: res.headers, bytes }
    }
    get = (path: string) => this.call("GET", path)
    post = (path: string, body: unknown = {}) => this.call("POST", path, { body })
    put = (path: string, body: unknown = {}) => this.call("PUT", path, { body })
    delete = (path: string) => this.call("DELETE", path)

    async signIn(who: { email: string; password: string }): Promise<this> {
        const res = await this.post("/api/auth/login", who)
        if (res.status !== 200) throw new Error(`sign-in as ${who.email} failed with ${res.status}`)
        return this
    }
}

/** Start the app on a free port. */
export async function listen(app: Application): Promise<{ server: Server; host: string; close(): Promise<void> }> {
    const server = app.listen(0)
    await new Promise((resolve) => server.once("listening", resolve))
    return {
        server,
        host: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    }
}

/** The office invites a new tenant onto a new unit, and the tenant signs up and signs in. Returns that tenant's client. */
export async function createTenant(admin: Client, host: string, appOrigin: string, name = "Extra Tenant"): Promise<Client> {
    const tag = Math.random().toString(36).slice(2, 8)
    const property = await admin.post("/api/manager/properties", { name: `${name} ${tag}`, address: "1 Test St" })
    const unit = await admin.post("/api/manager/units", { propertyId: property.body.id, unitNum: "T1" })
    const email = `${tag}@example.com`
    const lease = await admin.post("/api/manager/leases", { unitId: unit.body.id, startDate: "2026-09-01", monthlyRent: 700, newTenants: [{ name, email }] })
    if (lease.status !== 201) throw new Error(`could not create a lease: ${lease.status}`)
    const password = "extra-tenant-pw-1"
    const signup = await new Client(host, appOrigin).post("/api/auth/signup", { token: lease.body.invites[0].inviteToken, password })
    if (signup.status !== 201) throw new Error(`could not sign the tenant up: ${signup.status}`)
    return new Client(host, appOrigin).signIn({ email, password })
}
