// The Finance and Performance screens (005) over HTTP, on the full sample:
// the numbers agree with the ledger, P&L adds up, expiring leases and the
// renewal notice work, and only property managers can see any of it.
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { loadConfig } from "../config"
import { createContainer, type Container } from "../container"
import { createApp } from "../create-app"
import { seed } from "../db/seed"
import { PASSWORDS } from "../db/seed/data"
import type { Analytics, FinanceOverview } from "../types/finance"
import { freshDatabase, hasDatabase, type TestDatabase } from "./helpers"

const config = loadConfig({ NODE_ENV: "test" })

describe.skipIf(!hasDatabase)("finance, collections, P&L and performance", () => {
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
        return { get: (p: string) => call("GET", p), post: (p: string, b: unknown = {}) => call("POST", p, b), delete: (p: string) => call("DELETE", p) }
    }
    const signIn = async (email: string, password: string) => {
        const b = browser()
        expect((await b.post("/auth/login", { email, password })).status).toBe(200)
        return b
    }
    const sql = async <T = Record<string, unknown>>(q: string, params: unknown[] = []) => (await t.owner.query(q, params)).rows as T[]

    beforeAll(async () => {
        t = await freshDatabase("it_finance")
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

    it("only property managers can open it", async () => {
        const tenant = await signIn("tenant@example.com", PASSWORDS.tenant)
        const staff = await signIn("maintenance@example.com", PASSWORDS.staff)
        for (const path of ["/manager/finance", "/manager/analytics", "/manager/leases/expiring"]) {
            expect((await tenant.get(path)).status).toBe(403)
            expect((await staff.get(path)).status).toBe(403)
        }
        expect((await browser().get("/manager/finance")).status).toBe(401)
    })

    it("collections agree with every lease's balance, and P&L adds up", async () => {
        const office = await signIn("manager@example.com", PASSWORDS.staff)
        const res = await office.get("/manager/finance?period=12m")
        expect(res.status).toBe(200)
        const f = res.body as FinanceOverview

        // Every owing lease is in collections, with its unpaid amount equal to the ledger balance.
        const owing = await sql<{ leaseid: number; balance: string }>("SELECT LeaseID AS leaseid, balance::text FROM lease_balance WHERE balance > 0")
        expect(f.collections.map((c) => c.leaseId).sort()).toEqual(owing.map((o) => o.leaseid).sort())
        for (const o of owing) {
            const row = f.collections.find((c) => c.leaseId === o.leaseid)!
            expect(row.total).toBeCloseTo(Number(o.balance), 2)
            expect(row.d1_30 + row.d31_60 + row.d61_90 + row.d90plus + row.current).toBeCloseTo(row.total, 2)
        }
        expect(f.aging.total).toBeCloseTo(owing.reduce((s, o) => s + Number(o.balance), 0), 2)

        // Cash collected = payments in the period less refunds; the P&L lines add up to it.
        const cash = await sql<{ n: string }>(
            `SELECT COALESCE(sum(CASE direction WHEN 'charge' THEN amount ELSE -amount END), 0)::text AS n FROM Payment
             WHERE status = 'completed' AND ("timestamp" AT TIME ZONE 'America/Denver')::date BETWEEN $1 AND $2`, [f.period.from, f.period.to])
        expect(f.summary.cashCollected).toBeCloseTo(Number(cash[0]!.n), 2)
        const lines = f.pnl.income.reduce((s, l) => s + l.collected, 0) + f.pnl.prepaid + f.pnl.refunds
        expect(lines).toBeCloseTo(f.pnl.totalCollected, 2)
        expect(f.pnl.totalExpenses).toBeCloseTo(f.pnl.expenses.reduce((s, e) => s + e.amount, 0), 2)
        expect(f.pnl.netOperatingIncome).toBeCloseTo(f.pnl.totalCollected - f.pnl.totalExpenses, 2)
        expect(f.pnl.byProperty.reduce((s, p) => s + p.expenses, 0)).toBeCloseTo(f.pnl.totalExpenses, 2)
        expect(f.pnl.income.find((l) => l.category === "rent")!.billed).toBeGreaterThan(0)

        // Twelve months, oldest first, and the summary is consistent.
        expect(f.monthly).toHaveLength(12)
        expect(f.summary.paid + f.summary.open + f.summary.late).toBeCloseTo(f.summary.chargesDue, 2)
        expect(f.recentPayments.length).toBeGreaterThan(5)
        expect(f.recentPayments.every((p) => ["paid", "partial", "prepaid", "refund"].includes(p.status))).toBe(true)
    })

    it("a partial payment shows as partial, and a lease two months behind shows in 31–60 days", async () => {
        const office = await signIn("manager@example.com", PASSWORDS.staff)
        const f = (await office.get("/manager/finance?period=12m")).body as FinanceOverview
        const unit104 = f.recentPayments.find((p) => p.unitLabel === "Unit 104" && p.status === "partial")
        expect(unit104?.amount).toBe(520)
        const james = f.collections.find((c) => c.tenants.some((x) => x.email === "james.johnson@example.com"))!
        expect(james.total).toBeCloseTo(1820, 2)
        expect(james.d31_60 + james.d1_30).toBeGreaterThan(0)
        expect(james.tenants[0]!.phone).toBe("(575) 555-0102")
    })

    it("expenses: add one, see it in P&L, void it, and it drops out", async () => {
        const office = await signIn("manager@example.com", PASSWORDS.staff)
        const property = (await sql<{ pid: number }>("SELECT pID AS pid FROM Property WHERE Name = 'Mesilla Court'"))[0]!.pid
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Denver" })
        const before = ((await office.get("/manager/finance?period=this-month")).body as FinanceOverview).pnl.totalExpenses
        const added = await office.post("/manager/expenses", { category: "repairs", amount: 410.25, spentOn: today, propertyId: property, vendor: "Mesa Plumbing", description: "Test repair" })
        expect(added.status).toBe(201)
        const after = (await office.get("/manager/finance?period=this-month")).body as FinanceOverview
        expect(after.pnl.totalExpenses).toBeCloseTo(before + 410.25, 2)
        expect(after.expenses.some((e) => e.description === "Test repair" && e.createdBy === "Dana Whitfield")).toBe(true)
        expect((await office.delete(`/manager/expenses/${added.body.id}`)).status).toBe(200)
        expect((await office.delete(`/manager/expenses/${added.body.id}`)).status).toBe(404)
        expect(((await office.get("/manager/finance?period=this-month")).body as FinanceOverview).pnl.totalExpenses).toBeCloseTo(before, 2)
        expect((await office.post("/manager/expenses", { category: "yacht", amount: 5, spentOn: today })).status).toBe(400)
        expect((await (await signIn("maintenance@example.com", PASSWORDS.staff)).post("/manager/expenses", { category: "repairs", amount: 5, spentOn: today })).status).toBe(403)
    })

    it("tenants and maintenance staff cannot read expenses in the database either", async () => {
        const client = await t.app.connect()
        try {
            await client.query("BEGIN")
            await client.query("SELECT set_config('app.user_type', 'tenant', true), set_config('app.user_id', '1', true)")
            expect((await client.query("SELECT * FROM Expenses")).rowCount).toBe(0)
            await client.query("SELECT set_config('app.user_type', 'admin', true), set_config('app.user_id', '2', true), set_config('app.user_role', 'maintenance_staff', true)")
            expect((await client.query("SELECT * FROM Expenses")).rowCount).toBe(0)
            expect((await client.query("SELECT * FROM Lease_Renewal_Notices")).rowCount).toBe(0)
        } finally {
            await client.query("ROLLBACK")
            client.release()
        }
    })

    it("performance: totals agree across the portfolio and its properties", async () => {
        const office = await signIn("manager@example.com", PASSWORDS.staff)
        const a = (await office.get("/manager/analytics")).body as Analytics
        expect(a.kpis.units).toBe(18)
        expect(a.kpis.occupied).toBe(14)
        expect(a.properties.reduce((s, p) => s + p.units, 0)).toBe(a.kpis.units)
        expect(a.properties.reduce((s, p) => s + p.rentRoll, 0)).toBeCloseTo(a.kpis.rentRoll, 2)
        expect(a.kpis.collectionRate12m).toBeGreaterThan(0.5)
        expect(a.kpis.collectionRate12m).toBeLessThanOrEqual(1)
        expect(a.kpis.onTimeRate).toBeGreaterThan(0)
        expect(a.trend).toHaveLength(12)
        expect(a.kpis.expiring90).toBe(3)
        expect(a.maintenance.submitted + a.maintenance.inProgress).toBe(a.kpis.openMaintenance)
    })

    it("leases ending in 90 days, and the renewal notice messages the residents once per send", async () => {
        const office = await signIn("manager@example.com", PASSWORDS.staff)
        const res = await office.get("/manager/leases/expiring?days=90")
        expect(res.status, JSON.stringify(res.body)).toBe(200)
        expect(res.body.leases.map((l: { unitLabel: string }) => l.unitLabel)).toEqual(["Unit 102", "Unit 106", "Unit A4"])
        const first = res.body.leases[0]
        expect(first.daysLeft).toBe(25)
        expect(first.lastNotice).toBeNull()

        const draft = await office.get(`/manager/leases/${first.leaseId}/renewal-notice`)
        expect(draft.body.body).toMatch(/^Hi James, your lease for Unit 102 at Woodcrest Apartments ends on/)
        const sent = await office.post(`/manager/leases/${first.leaseId}/renewal-notice`, {})
        expect(sent.status).toBe(201)
        expect(sent.body.recipients).toBe(1)

        const again = (await office.get("/manager/leases/expiring?days=90")).body.leases[0]
        expect(again.lastNotice?.recipients).toBe(1)
        const james = await signIn("james.johnson@example.com", PASSWORDS.tenant)
        const thread = await james.get("/tenant/messages")
        expect(JSON.stringify(thread.body)).toContain("ends on")

        // Collections now shows when the office last reached James.
        const f = (await office.get("/manager/finance?period=12m")).body as FinanceOverview
        expect(f.collections.find((c) => c.leaseId === first.leaseId)?.lastContactAt).not.toBeNull()
        expect((await office.get("/manager/leases/expiring?days=0")).status).toBe(400)
    })
})
