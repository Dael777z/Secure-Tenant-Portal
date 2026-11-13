// Juan's tenant side, made real (006), over HTTP on the full sample:
// Cash App / Zelle payments a tenant reports and the office confirms or
// rejects, the office's handles, the tenant's own name / phone and email
// choices, and the database rules behind them.
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import { PASSWORDS } from "../db/seed/data"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

const config = loadConfig({ NODE_ENV: "test" })

// 012: a Cash App report carries the payment's identifier and a screenshot (here, the smallest thing that is a PNG).
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64")
const evidence = { transactionRef: "#D1AB2C3", proof: { filename: "cashapp.png", data: PNG } }

describe.skipIf(!hasDatabase)("tenant settings and reported Cash App / Zelle payments", () => {
    let t: TestDatabase
    let container: Container
    let server: Server
    let base: string

    const browser = () => {
        const cookies = new Map<string, string>()
        const call = async (method: string, path: string, body?: unknown) => {
            const res = await fetch(`${base}${path}`, {
                method,
                headers: {
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                    ...(method === "GET" ? {} : { origin: config.webOrigin }),
                    cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            })
            for (const line of res.headers.getSetCookie()) {
                const [name, value] = line.split(";")[0]!.split("=")
                if (value) cookies.set(name!, value)
            }
            const text = await res.text()
            return { status: res.status, body: text ? JSON.parse(text) : {} }
        }
        return {
            get: (p: string) => call("GET", p),
            post: (p: string, b: unknown = {}) => call("POST", p, b),
            put: (p: string, b: unknown = {}) => call("PUT", p, b),
            del: (p: string) => call("DELETE", p),
            /** For fetching a file (the helpers above read JSON). */
            cookie: async () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        }
    }
    const signIn = async (email: string, password: string) => {
        const b = browser()
        expect((await b.post("/auth/login", { email, password })).status).toBe(200)
        return b
    }
    const office = () => signIn("manager@example.com", PASSWORDS.staff)
    const resident = (email: string) => signIn(email, PASSWORDS.tenant)

    beforeAll(async () => {
        t = await freshDatabase("it_tenant_settings")
        await seed(t.owner, { webOrigin: config.webOrigin, bcryptRounds: 4 })
        container = createContainer({ config, db: t.db, plaid: null })
        server = createApp(container).listen(0)
        await new Promise((resolve) => server.once("listening", resolve))
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
    })
    afterAll(async () => {
        await new Promise((resolve) => server?.close(resolve))
        await container?.close()
        await t?.drop()
    })

    it("the summary carries contact details, where to send Cash App / Zelle, email choices and the waiting report", async () => {
        const lucia = await resident("lucia.reyes@example.com")
        const s = (await lucia.get("/tenant/summary")).body
        expect(s.contact).toEqual({ email: "lucia.reyes@example.com", phone: "(575) 555-0202" })
        expect(s.payOptions).toEqual({ cashapp: "$SummitPM", zelle: "payments@summitpm.example", zellePhone: null, cashappQrAt: null, zelleQrAt: null, requirePaymentRef: false })
        expect(s.notificationPrefs).toEqual({ rentDue: true, paymentReceipts: true, maintenance: true, messages: true })
        expect(s.reportedPayments).toHaveLength(1)
        expect(s.reportedPayments[0]).toMatchObject({ method: "zelle", amount: 1290, status: "pending", reason: null })
        // Reported money doesn't count until the office confirms it.
        expect(s.currentBalance).toBe(1290)
    })

    it("while a report waits, the tenant can't report again or pay by bank (no paying twice)", async () => {
        const lucia = await resident("lucia.reyes@example.com")
        expect(await lucia.post("/tenant/payments/report", { method: "cashapp", amount: 1290, ...evidence })).toMatchObject({ status: 409, body: { error: "ALREADY_REPORTED" } })
        expect(await lucia.post("/tenant/payments", { amount: 1290 })).toMatchObject({ status: 409, body: { error: "ALREADY_REPORTED" } })
    })

    it("the office sees it to confirm, confirms it, the balance clears and the tenant is told", async () => {
        const manager = await office()
        const waiting = (await manager.get("/manager/payments/reported")).body.payments
        const report = waiting.find((p: { tenantName: string }) => p.tenantName === "Lucia Reyes")
        expect(report).toMatchObject({ method: "zelle", amount: 1290, balance: 1290, status: "pending", unitLabel: "Unit A2", propertyName: "Mesilla Court" })
        const updates = (await manager.get("/manager/updates")).body.updates
        expect(updates.some((u: { kind: string; amount: number }) => u.kind === "payment_reported" && u.amount === 1290)).toBe(true)

        const confirmed = await manager.post(`/manager/payments/${report.id}/confirm`)
        expect(confirmed.status).toBe(200)
        expect(confirmed.body).toMatchObject({ status: "confirmed", balance: 0, reviewedBy: "Dana Whitfield" })
        expect((await manager.post(`/manager/payments/${report.id}/confirm`)).status).toBe(404)
        expect((await manager.get("/manager/payments/reported")).body.payments.some((p: { id: number }) => p.id === report.id)).toBe(false)
        // 012: once confirmed, it is news in the office's updates instead of something to decide.
        const after = (await manager.get("/manager/updates")).body.updates
        expect(after.some((u: { kind: string; amount: number }) => u.kind === "payment_confirmed" && u.amount === 1290)).toBe(true)
        expect(after.some((u: { kind: string; amount: number }) => u.kind === "payment_reported" && u.amount === 1290)).toBe(false)

        const lucia = await resident("lucia.reyes@example.com")
        const s = (await lucia.get("/tenant/summary")).body
        expect(s.currentBalance).toBe(0)
        expect(s.reportedPayments[0]).toMatchObject({ status: "confirmed" })
        expect(s.ledger.some((e: { amount: number; method: string }) => e.amount === 1290 && /Zelle/.test(e.method))).toBe(true)
        expect(JSON.stringify((await lucia.get("/tenant/messages")).body)).toContain("We received your Zelle payment")
    })

    it("a report covers at least the balance; a rejected report says why and can be sent again", async () => {
        const james = await resident("james.johnson@example.com")
        const owed = (await james.get("/tenant/summary")).body.currentBalance as number
        expect(owed).toBeCloseTo(1820, 2)
        expect(await james.post("/tenant/payments/report", { method: "cashapp", amount: 910, ...evidence })).toMatchObject({ status: 409, body: { error: "AMOUNT_BELOW_BALANCE" } })
        expect(await james.post("/tenant/payments/report", { method: "cashapp", amount: 99_999, ...evidence })).toMatchObject({ status: 409, body: { error: "AMOUNT_ABOVE_LIMIT" } })
        expect((await james.post("/tenant/payments/report", { method: "venmo", amount: owed })).status).toBe(400)
        // 012, 013: a report always needs a screenshot that really is an image, for Cash App and for Zelle.
        expect((await james.post("/tenant/payments/report", { method: "cashapp", amount: owed })).status).toBe(400)
        expect((await james.post("/tenant/payments/report", { method: "zelle", amount: owed })).status).toBe(400)
        expect((await james.post("/tenant/payments/report", { method: "cashapp", amount: owed, transactionRef: "#D1AB2C3" })).status).toBe(400)
        expect(await james.post("/tenant/payments/report", { method: "cashapp", amount: owed, transactionRef: "#D1AB2C3", proof: { filename: "x.png", data: Buffer.from("not an image").toString("base64") } }))
            .toMatchObject({ body: { error: "FILE_INVALID" } })
        // 013: the confirmation number is optional unless the office requires it.
        const manager = await office()
        const handles = { cashappHandle: "$SummitPM", zelleHandle: "payments@summitpm.example", zellePhone: null }
        expect((await manager.put("/manager/settings", { ...handles, requirePaymentRef: true })).body).toMatchObject({ requirePaymentRef: true })
        expect((await james.get("/tenant/summary")).body.payOptions.requirePaymentRef).toBe(true)
        expect((await james.post("/tenant/payments/report", { method: "cashapp", amount: owed, proof: evidence.proof })).status).toBe(400)
        expect((await james.post("/tenant/payments/report", { method: "zelle", amount: owed, proof: evidence.proof })).status).toBe(400)
        expect((await manager.put("/manager/settings", { ...handles, requirePaymentRef: "yes" })).status).toBe(400)
        expect((await manager.put("/manager/settings", { ...handles, requirePaymentRef: false })).body).toMatchObject({ requirePaymentRef: false })
        // Not required: the screenshot alone is enough.
        const sent = await james.post("/tenant/payments/report", { method: "cashapp", amount: owed, idempotencyKey: "report-james-1", proof: evidence.proof })
        expect(sent.status).toBe(201)
        expect((await james.get("/tenant/summary")).body.currentBalance).toBeCloseTo(1820, 2)

        const report = (await manager.get("/manager/payments/reported")).body.payments.find((p: { tenantName: string }) => p.tenantName === "James Johnson")
        // The office can open the screenshot; another tenant can't.
        expect(report).toMatchObject({ transactionRef: null, hasProof: true })
        const proof = await fetch(`${base}/manager/payments/${report.id}/proof`, { headers: { cookie: (await manager.cookie()) } })
        expect(proof.status).toBe(200)
        expect(proof.headers.get("content-type")).toBe("image/png")
        expect((await james.get(`/manager/payments/${report.id}/proof`)).status).toBe(403)
        expect((await manager.post(`/manager/payments/${report.id}/reject`, { reason: "" })).status).toBe(400)
        const rejected = await manager.post(`/manager/payments/${report.id}/reject`, { reason: "No Cash App payment from James arrived" })
        expect(rejected.body).toMatchObject({ status: "rejected", reason: "No Cash App payment from James arrived" })

        const after = (await james.get("/tenant/summary")).body
        expect(after.currentBalance).toBeCloseTo(1820, 2)
        expect(after.reportedPayments[0]).toMatchObject({ status: "rejected", reason: "No Cash App payment from James arrived" })
        expect(JSON.stringify((await james.get("/tenant/messages")).body)).toContain("couldn't match your Cash App payment")
        // Free to try again, this time by Zelle with its confirmation number.
        expect((await james.post("/tenant/payments/report", { method: "zelle", amount: owed, ...evidence })).status).toBe(201)
        // All reports, decided ones included.
        const all = (await manager.get("/manager/payments/reported?status=all")).body.payments
        expect(all.find((p: { tenantName: string; status: string }) => p.tenantName === "James Johnson" && p.status === "pending")).toMatchObject({ method: "zelle", transactionRef: "#D1AB2C3", hasProof: true })
        expect(all.filter((p: { tenantName: string }) => p.tenantName === "James Johnson").map((p: { status: string }) => p.status).sort()).toEqual(["pending", "rejected"])
    })

    it("the office sets its own handles; a method turned off can't be used", async () => {
        const manager = await office()
        expect((await manager.get("/manager/settings")).body).toMatchObject({ cashappHandle: "$SummitPM", zelleHandle: "payments@summitpm.example" })
        expect((await manager.put("/manager/settings", { cashappHandle: "SummitPM", zelleHandle: null })).status).toBe(400)   // no $
        expect((await manager.put("/manager/settings", { cashappHandle: "$Summit", zelleHandle: "not-an-email" })).status).toBe(400)
        // 013: Zelle has an email and a phone number; the email field takes only an email, the phone field only a phone number.
        expect((await manager.put("/manager/settings", { cashappHandle: null, zelleHandle: "(575) 555-0100" })).status).toBe(400)
        expect((await manager.put("/manager/settings", { cashappHandle: null, zelleHandle: null, zellePhone: "555-0100" })).status).toBe(400)
        expect((await manager.put("/manager/settings", { cashappHandle: null, zelleHandle: null, zellePhone: "payments@summitpm.example" })).status).toBe(400)
        expect((await manager.put("/manager/settings", { cashappHandle: null, zelleHandle: null, zellePhone: "(575) 555-0100" })).body)
            .toMatchObject({ cashappHandle: null, zelleHandle: null, zellePhone: "(575) 555-0100", requirePaymentRef: false, updatedBy: "Dana Whitfield" })

        const raj = await resident("raj.johnson@example.com")
        expect((await raj.get("/tenant/summary")).body.payOptions).toEqual({ cashapp: null, zelle: null, zellePhone: "(575) 555-0100", cashappQrAt: null, zelleQrAt: null, requirePaymentRef: false })
        expect(await raj.post("/tenant/payments/report", { method: "cashapp", amount: 990, ...evidence })).toMatchObject({ status: 409, body: { error: "METHOD_NOT_AVAILABLE" } })
        // Zelle with neither an email nor a phone number is off too.
        await manager.put("/manager/settings", { cashappHandle: null, zelleHandle: null, zellePhone: null })
        expect(await raj.post("/tenant/payments/report", { method: "zelle", amount: 990, ...evidence })).toMatchObject({ status: 409, body: { error: "METHOD_NOT_AVAILABLE" } })
        expect((await manager.put("/manager/settings", { cashappHandle: null, zelleHandle: "payments@summitpm.example", zellePhone: "(575) 555-0100" })).body)
            .toMatchObject({ zelleHandle: "payments@summitpm.example", zellePhone: "(575) 555-0100" })
        expect((await raj.put("/manager/settings", { cashappHandle: "$Mine", zelleHandle: null })).status).toBe(403)
        const staff = await signIn("maintenance@example.com", PASSWORDS.staff)
        expect((await staff.get("/manager/settings")).status).toBe(403)
        expect((await staff.get("/manager/payments/reported")).status).toBe(403)
        await manager.put("/manager/settings", { cashappHandle: "$SummitPM", zelleHandle: "payments@summitpm.example" })
    })

    it.each(["cashapp", "zelle"] as const)("the office uploads its %s QR code; tenants see it, and only a manager can change it (012, 013)", async (method) => {
        const at = `${method}QrAt`
        const other = method === "cashapp" ? "zelle" : "cashapp"
        const manager = await office()
        const tenant = await resident("tenant@example.com")
        expect((await tenant.get(`/tenant/${method}-qr`)).status).toBe(404)
        expect(await manager.put(`/manager/settings/${method}-qr`, { filename: "qr.txt", data: Buffer.from("hello").toString("base64") })).toMatchObject({ body: { error: "FILE_INVALID" } })
        expect((await tenant.put(`/manager/settings/${method}-qr`, { filename: "qr.png", data: PNG })).status).toBe(403)

        const saved = await manager.put(`/manager/settings/${method}-qr`, { filename: "qr.png", data: PNG })
        expect(saved.status).toBe(200)
        expect(saved.body[at]).toEqual(expect.any(String))
        // One method's code is not the other's.
        expect(saved.body[`${other}QrAt`]).toBeNull()
        expect((await tenant.get(`/tenant/${other}-qr`)).status).toBe(404)
        expect((await tenant.get("/tenant/summary")).body.payOptions[at]).toBe(saved.body[at])
        const image = await fetch(`${base}/tenant/${method}-qr`, { headers: { cookie: await tenant.cookie() } })
        expect(image.status).toBe(200)
        expect(image.headers.get("content-type")).toBe("image/png")
        expect(Buffer.from(await image.arrayBuffer()).toString("base64")).toBe(PNG)
        // Replacing keeps one row; removing takes it away.
        expect((await manager.put(`/manager/settings/${method}-qr`, { filename: "qr2.png", data: PNG })).status).toBe(200)
        expect((await t.owner.query("SELECT 1 FROM Office_Payment_Qr WHERE method = $1", [method])).rowCount).toBe(1)
        expect((await manager.del(`/manager/settings/${method}-qr`)).body[at]).toBeNull()
        expect((await tenant.get(`/tenant/${method}-qr`)).status).toBe(404)
    })

    it("a tenant edits their own name and phone, and their email choices", async () => {
        const tenant = await resident("tenant@example.com")
        expect((await tenant.put("/tenant/profile", { name: "Test T. Tenant", phone: "(575) 555-0199" })).status).toBe(200)
        const s = (await tenant.get("/tenant/summary")).body
        expect(s.tenant.name).toBe("Test T. Tenant")
        expect(s.contact).toEqual({ email: "tenant@example.com", phone: "(575) 555-0199" })
        expect((await tenant.put("/tenant/profile", { name: "  ", phone: null })).status).toBe(400)
        expect((await tenant.put("/tenant/profile", { name: "Test Tenant", phone: "call me maybe" })).status).toBe(400)
        expect((await tenant.put("/tenant/profile", { name: "Test Tenant", phone: "" })).status).toBe(200)
        expect((await tenant.get("/tenant/summary")).body.contact.phone).toBeNull()
        // The office sees the change.
        const row = (await (await office()).get("/manager/tenants")).body.tenants.find((x: { email: string }) => x.email === "tenant@example.com")
        expect(row.name).toBe("Test Tenant")

        const prefs = { rentDue: true, paymentReceipts: false, maintenance: true, messages: false }
        expect((await tenant.put("/tenant/notifications", prefs)).body).toEqual(prefs)
        expect((await tenant.get("/tenant/summary")).body.notificationPrefs).toEqual(prefs)
        expect((await tenant.put("/tenant/notifications", { rentDue: "yes" })).status).toBe(400)
        expect((await (await office()).put("/tenant/profile", { name: "Not a tenant" })).status).toBe(403)
    })

    it("in the database: tenants read only their own reports and choices, and can change only their own name and phone", async () => {
        const ids = (await t.owner.query<{ tid: number; email: string }>("SELECT tID AS tid, Email AS email FROM Tenants")).rows
        const lucia = ids.find((r) => r.email === "lucia.reyes@example.com")!.tid
        const james = ids.find((r) => r.email === "james.johnson@example.com")!.tid
        const client = await t.app.connect()
        try {
            await client.query("BEGIN")
            await client.query("SELECT set_config('app.user_type', 'tenant', true), set_config('app.user_id', $1, true)", [String(lucia)])
            const reports = (await client.query("SELECT reported_by FROM Reported_Payments")).rows
            expect(reports.length).toBeGreaterThan(0)
            expect(reports.every((r) => r.reported_by === lucia)).toBe(true)
            expect((await client.query("SELECT * FROM Tenant_Notification_Prefs WHERE tID = $1", [james])).rowCount).toBe(0)
            await expect(client.query("INSERT INTO Tenant_Notification_Prefs (tID) VALUES ($1)", [james])).rejects.toThrow()
        } finally {
            await client.query("ROLLBACK")
        }
        try {
            await client.query("BEGIN")
            // Tenants never write payments or reports themselves, nor touch the office's handles.
            await client.query("SELECT set_config('app.user_type', 'tenant', true), set_config('app.user_id', $1, true)", [String(lucia)])
            expect((await client.query("UPDATE Office_Settings SET cashapp_handle = '$Thief' WHERE id")).rowCount).toBe(0)
        } finally {
            await client.query("ROLLBACK")
        }
        try {
            await client.query("BEGIN")
            await client.query("SELECT set_config('app.user_type', 'admin', true), set_config('app.user_id', '1', true), set_config('app.user_role', 'admin', true)")
            // Not a tenant: the profile function changes nothing.
            expect((await client.query("SELECT tenant_update_own_profile('Hacker', NULL) AS ok")).rows[0].ok).toBe(false)
        } finally {
            await client.query("ROLLBACK")
            client.release()
        }
        // Payments are never deleted, reviews are kept.
        await expect(t.owner.query("DELETE FROM Payment WHERE payID = (SELECT payID FROM Reported_Payments LIMIT 1)")).rejects.toThrow()
    })
})
