import { describe, expect, it, vi } from "vitest"

import { runAs } from "../db/identity"
import type { AdditionsStore } from "../types/stores"
import { csvMoney, toCsv } from "../utils/csv"
import { DOCUMENT_TYPES, PHOTO_TYPES, readUpload, sniff } from "../utils/uploads"
import { LeasingService } from "./leasing-service"
import { MaintenanceDetailService } from "./maintenance-detail-service"
import { NoticesService } from "./notices-service"
import { auditSummary, OfficeService } from "./office-service"

/**
 * The 009 services on a stand-in store: the rules they apply before or after
 * the database (who may change whom, warnings, CSV columns, upload checks).
 * The database side is in portal-additions.integration.test.ts.
 */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64")
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")])
const PDF = Buffer.from("%PDF-1.4\n%%EOF")

const store = (methods: Record<string, unknown>) => methods as unknown as AdditionsStore
const admin = { type: "admin" as const, id: 1, role: "admin" as const }
const tenantWho = { type: "tenant" as const, id: 7 }

describe("CSV (toCsv, csvMoney)", () => {
    it("starts with a byte-order mark, ends lines with CRLF and quotes what needs quoting", () => {
        const csv = toCsv(["Name", "Note"], [["Ana, B", 'say "hi"'], [null, undefined], [true, false], [3, "line\nbreak"]])
        expect(csv.startsWith("﻿")).toBe(true)
        expect(csv.slice(1).split("\r\n")).toEqual(["Name,Note", '"Ana, B","say ""hi"""', ",", "yes,no", '3,"line\nbreak"', ""])
    })

    it("shows a cell that looks like a formula as text, but leaves negative numbers alone", () => {
        expect(toCsv(["a", "b", "c", "d"], [["=SUM(A1)", "+1", "@x", -5]]).split("\r\n")[1]).toBe("'=SUM(A1),'+1,'@x,-5")
        expect(toCsv(["a"], [["-2"]]).split("\r\n")[1]).toBe("'-2")
    })

    it("money has two decimals and no symbol; nothing stays empty", () => {
        expect(csvMoney(1234.5)).toBe("1234.50")
        expect(csvMoney(0.005)).toBe("0.01")
        expect(csvMoney(null)).toBe("")
        expect(csvMoney(undefined)).toBe("")
    })
})

describe("uploads (sniff, readUpload)", () => {
    it("knows a file by its first bytes", () => {
        expect(sniff(PDF)).toBe("application/pdf")
        expect(sniff(JPEG)).toBe("image/jpeg")
        expect(sniff(PNG)).toBe("image/png")
        expect(sniff(WEBP)).toBe("image/webp")
        expect(sniff(Buffer.from("GIF89a"))).toBeNull()
        expect(sniff(Buffer.from("RIFFxxxxWAVE"))).toBeNull()
        expect(sniff(Buffer.alloc(0))).toBeNull()
    })

    it("reads a base64 file, cleans its name and hashes it", () => {
        const file = readUpload({ filename: "  a/b\\c\u0001.png  ", data: PNG.toString("base64") }, PHOTO_TYPES, 1024)
        expect(file).toMatchObject({ filename: "a_b_c_.png", contentType: "image/png" })
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(readUpload({ data: PDF.toString("base64") }, DOCUMENT_TYPES, 1024).filename).toBe("file")
        expect(readUpload({ filename: "   ", data: PDF.toString("base64") }, DOCUMENT_TYPES, 1024).filename).toBe("file")
    })

    it("refuses what is not base64, empty, the wrong kind or too big", () => {
        const code = (body: unknown, max = 1024, accept: readonly string[] = PHOTO_TYPES) => {
            try {
                readUpload(body, accept, max)
                return "ok"
            } catch (e) {
                return (e as { code: string }).code
            }
        }
        expect(code(undefined)).toBe("FILE_INVALID")
        expect(code({ data: 5 })).toBe("FILE_INVALID")
        expect(code({ data: "" })).toBe("FILE_INVALID")
        expect(code({ data: "not base64!" })).toBe("FILE_INVALID")
        expect(code({ data: "====" })).toBe("FILE_INVALID")
        expect(code({ data: PDF.toString("base64") })).toBe("FILE_INVALID")                // a PDF is not a photo
        expect(code({ data: Buffer.from("plain text").toString("base64") }, 1024, DOCUMENT_TYPES)).toBe("FILE_INVALID")
        expect(code({ data: PNG.toString("base64") }, 10)).toBe("FILE_TOO_LARGE")
        expect(code({ data: Buffer.alloc(12, 1).toString("base64") }, 11)).toBe("FILE_TOO_LARGE")   // "=" padding counted
        expect(code({ data: Buffer.alloc(13, 1).toString("base64") }, 12)).toBe("FILE_TOO_LARGE")   // "==" padding counted
    })
})

describe("the activity log's summaries (auditSummary)", () => {
    it("names created and deleted rows", () => {
        expect(auditSummary("lease", "4", "INSERT", null, { id: 4 })).toBe("Lease 4 created")
        expect(auditSummary("mystery", "9", "DELETE", { id: 9 }, null)).toBe("mystery 9 deleted")
    })

    it("lists what changed, leaving out noise, and shortens long values", () => {
        const long = "x".repeat(60)
        expect(auditSummary("lease", "4", "UPDATE", { end_date: null, monthly_rent: 950, updated_at: 1 }, { end_date: "2026-12-31", monthly_rent: 975, updated_at: 2 }))
            .toBe("Lease 4: end_date — → 2026-12-31; monthly_rent 950 → 975")
        expect(auditSummary("tenants", "2", "UPDATE", { notes: "" }, { notes: long })).toBe(`Tenant 2: notes — → ${"x".repeat(39)}…`)
        expect(auditSummary("tenants", "2", "UPDATE", { meta: { a: 1 } }, { meta: { a: 2 } })).toBe('Tenant 2: meta {"a":1} → {"a":2}')
        expect(auditSummary("tenants", "2", "UPDATE", { updated_at: 1 }, { updated_at: 2 })).toBe("Tenant 2 updated")
        expect(auditSummary("tenants", "2", "UPDATE", null, null)).toBe("Tenant 2 updated")
    })

    it("stops at six changes and says how many more", () => {
        const before = Object.fromEntries("abcdefgh".split("").map((k) => [k, 1]))
        const after = Object.fromEntries("abcdefgh".split("").map((k) => [k, 2]))
        expect(auditSummary("units", "1", "UPDATE", before, after)).toMatch(/; f 1 → 2 \(\+2 more\)$/)
    })
})

describe("OfficeService", () => {
    const member = (over: Record<string, unknown> = {}) => ({ id: 5, name: "Luis", email: "l@x.com", role: "maintenance_staff", status: "active", mfaEnabled: false, lastLoginAt: null, ...over })
    const teamStore = (found: unknown, others = 1) => {
        const s = {
            findTeamMember: vi.fn(async () => found),
            countOtherActiveManagers: vi.fn(async () => others),
            updateStaff: vi.fn(async () => undefined),
            deactivateStaff: vi.fn(async () => undefined),
            reissueStaffInvite: vi.fn(async () => undefined),
            resetStaffSignIn: vi.fn(async () => undefined),
            inviteStaff: vi.fn(async () => 9),
            recordSecurityEvent: vi.fn(async () => undefined),
        }
        return { s, office: new OfficeService(store(s), "America/Denver") }
    }
    const code = async (work: () => Promise<unknown>) => {
        try {
            await work()
            return "ok"
        } catch (e) {
            return (e as { code: string }).code
        }
    }

    it("invites with a sign-up link and records it", async () => {
        const { s, office } = teamStore(null)
        const made = await runAs(admin, () => office.invite({ name: "Pat", email: "p@x.com", role: "admin" }))
        expect(made.id).toBe(9)
        expect(made.inviteToken.length).toBeGreaterThan(20)
        expect(s.recordSecurityEvent).toHaveBeenCalledWith("admin:1", "team_invite", "Invited Pat (property manager)", expect.anything())
        await runAs({ type: "system" }, () => office.invite({ name: "Mo", email: "m@x.com", role: "maintenance_staff" }))
        expect(s.recordSecurityEvent).toHaveBeenLastCalledWith("system", "team_invite", "Invited Mo (maintenance)", expect.anything())
        await office.invite({ name: "Anon", email: "a@x.com", role: "admin" })
        expect(s.recordSecurityEvent).toHaveBeenLastCalledWith(null, "team_invite", expect.any(String), expect.anything())
    })

    it("refuses missing or deactivated teammates", async () => {
        for (const found of [null, member({ status: "deactivated" })]) {
            const { office } = teamStore(found)
            await runAs(admin, async () => {
                expect(await code(() => office.updateMember(5, { name: "X" }))).toBe("NOT_FOUND")
                expect(await code(() => office.deactivate(5))).toBe("NOT_FOUND")
                expect(await code(() => office.reissueInvite(5))).toBe("NOT_FOUND")
                expect(await code(() => office.resetSignIn(5))).toBe("NOT_FOUND")
            })
        }
    })

    it("won't let a manager change their own role, deactivate or reset themselves", async () => {
        const { office } = teamStore(member({ id: 1, role: "admin" }))
        await runAs(admin, async () => {
            expect(await code(() => office.updateMember(1, { role: "maintenance_staff" }))).toBe("SELF_CHANGE_FORBIDDEN")
            expect(await code(() => office.deactivate(1))).toBe("SELF_CHANGE_FORBIDDEN")
            expect(await code(() => office.resetSignIn(1))).toBe("SELF_CHANGE_FORBIDDEN")
            expect(await code(() => office.updateMember(1, { name: "Dana W" }))).toBe("ok")       // a name is fine
        })
    })

    it("keeps at least one active property manager", async () => {
        const { office } = teamStore(member({ role: "admin" }), 0)
        await runAs(admin, async () => {
            expect(await code(() => office.updateMember(5, { role: "maintenance_staff" }))).toBe("LAST_ADMIN")
            expect(await code(() => office.deactivate(5))).toBe("LAST_ADMIN")
        })
        const invited = teamStore(member({ role: "admin", status: "invited" }), 0)
        await runAs(admin, async () => expect(await code(() => invited.office.deactivate(5))).toBe("ok"))
    })

    it("records only real changes", async () => {
        const { s, office } = teamStore(member())
        await runAs(admin, async () => {
            await office.updateMember(5, { name: "Luis", role: "maintenance_staff" })
            expect(s.recordSecurityEvent).not.toHaveBeenCalled()
            await office.updateMember(5, { name: "Luis G", role: "admin" })
            expect(s.recordSecurityEvent).toHaveBeenLastCalledWith("admin:1", "team_update", "Changed Luis's name to Luis G and role to admin", { adminId: 5 })
            await office.updateMember(5, {})
            await office.deactivate(5)
            expect((await office.reissueInvite(5)).inviteToken).toBeTruthy()
            expect((await office.resetSignIn(5)).inviteToken).toBeTruthy()
        })
        expect((s.recordSecurityEvent.mock.calls as unknown[][]).map((c) => c[1])).toEqual(["team_update", "team_deactivate", "team_reissue", "team_reset"])
    })

    describe("activity", () => {
        const at = (n: number) => `2026-11-0${n}T00:00:00.000Z`
        const changes = [
            { at: at(1), by: "admin:1", table: "lease", rowPk: "4", action: "INSERT", before: null, after: { id: 4 } },
            { at: at(3), by: "admin:1", table: "admin", rowPk: "1", action: "UPDATE", before: { last_login_at: "a" }, after: { last_login_at: "b" } },
            { at: at(3), by: "admin:1", table: "admin", rowPk: "1", action: "UPDATE", before: { last_login_at: "a", name: "D" }, after: { last_login_at: "b", name: "E" } },
            { at: at(2), by: null, table: "admin", rowPk: "2", action: "INSERT", before: null, after: { id: 2 } },
            { at: at(2), by: null, table: "admin", rowPk: "3", action: "DELETE", before: { id: 3 }, after: null },
        ]
        const security = [{ at: at(2), by: "admin:1", action: "login_success", summary: "Signed in", details: {} }, { at: at(2), by: null, action: "login_failed", summary: "x", details: {} }]
        const make = () => {
            const s = {
                listAudit: vi.fn(async () => changes),
                listSecurityEvents: vi.fn(async () => security),
                actorNames: vi.fn(async () => new Map([["admin:1", "Dana"]])),
            }
            return { s, office: new OfficeService(store(s), "America/Denver") }
        }

        it("merges changes and sign-ins newest first, without bare sign-in stamps", async () => {
            const { office } = make()
            const all = await office.activity({ kind: null, table: null, since: null, limit: 50 } as never)
            expect(all).toHaveLength(6)
            expect(all[0]!.summary).toBe("Staff account 1: last_login_at a → b; name D → E")
            expect(all.at(-1)!.summary).toBe("Lease 4 created")
            expect(all.find((e) => e.kind === "security")!.byName).toBe("Dana")
            expect(all.filter((e) => e.by === null).every((e) => e.byName === null)).toBe(true)
            expect(await office.activity({ kind: null, table: null, since: null, limit: 2 } as never)).toHaveLength(2)
        })

        it("filters by kind and table", async () => {
            const { s, office } = make()
            expect((await office.activity({ kind: "security", table: null, since: null, limit: 50 } as never)).every((e) => e.kind === "security")).toBe(true)
            expect(s.listAudit).not.toHaveBeenCalled()
            expect((await office.activity({ kind: "change", table: null, since: null, limit: 50 } as never)).every((e) => e.kind === "change")).toBe(true)
            expect((await office.activity({ kind: null, table: "lease", since: null, limit: 50 } as never)).every((e) => e.kind === "change")).toBe(true)
            expect(s.listSecurityEvents).toHaveBeenCalledTimes(1)
        })

        it("downloads as CSV", async () => {
            const csv = await make().office.activityCsv({ kind: null, table: null, since: null, limit: 50 } as never)
            const lines = csv.slice(1).split("\r\n")
            expect(lines[0]).toBe("When,Who,Kind,Record,Action,Summary")
            expect(lines).toContain(`${at(2)},Dana,security,,login_success,Signed in`)
            expect(lines).toContain(`${at(2)},,change,admin 2,INSERT,Staff account 2 created`)
        })
    })

    it("portfolios: occupancy, and none for a portfolio with no units", async () => {
        const s = {
            listPortfolios: vi.fn(async () => [
                { id: 1, name: "A", entityName: null, properties: [{ id: 1, name: "P1" }], units: 4, occupied: 3, monthlyRent: 4000, outstanding: 12.5 },
                { id: 2, name: "Empty", entityName: "E LLC", properties: [], units: 0, occupied: 0, monthlyRent: 0, outstanding: 0 },
            ]),
            listUnassignedProperties: vi.fn(async () => [{ id: 3, name: "Lone" }]),
            savePortfolio: vi.fn(async () => 7),
            retirePortfolio: vi.fn(async () => undefined),
        }
        const office = new OfficeService(store(s), "America/Denver")
        const { portfolios } = await office.portfolios()
        expect(portfolios.map((f) => [f.propertyCount, f.occupancy])).toEqual([[1, 0.75], [0, 0]])
        const csv = (await office.exportCsv("portfolios", {})).csv.slice(1).split("\r\n")
        expect(csv[1]).toBe("A,,P1,4,3,75%,4000.00,12.50")
        expect(csv[2]).toBe("Empty,E LLC,,0,0,,0.00,0.00")
        expect(csv[3]).toBe("Not in a portfolio,,Lone,,,,,")
        s.listUnassignedProperties.mockResolvedValueOnce([])
        expect((await office.exportCsv("portfolios", {})).csv).not.toContain("Not in a portfolio")
        expect(await office.savePortfolio(null, { name: "N", entityName: null } as never)).toBe(7)
        await office.savePortfolio(7, { name: "N", entityName: null } as never)
        await office.retirePortfolio(7)
        expect(s.retirePortfolio).toHaveBeenCalledWith(7)
    })

    it("details: missing is NOT_FOUND and a time zone must be real", async () => {
        const s = {
            propertyDetails: vi.fn(async () => null),
            tenantDetails: vi.fn(async () => null),
            savePropertyDetails: vi.fn(async () => undefined),
            saveTenantDetails: vi.fn(async () => undefined),
        }
        const office = new OfficeService(store(s), "America/Denver")
        expect(await code(() => office.propertyDetails(1))).toBe("NOT_FOUND")
        expect(await code(() => office.tenantDetails(1))).toBe("NOT_FOUND")
        s.propertyDetails.mockResolvedValueOnce({ id: 1 } as never)
        s.tenantDetails.mockResolvedValueOnce({ id: 1 } as never)
        expect(await office.propertyDetails(1)).toEqual({ id: 1 })
        expect(await office.tenantDetails(1)).toEqual({ id: 1 })
        expect(await code(() => office.savePropertyDetails(1, { timeZone: "Mars/Olympus" } as never))).toBe("VALIDATION_ERROR")
        expect(await code(() => office.savePropertyDetails(1, { timeZone: "America/Phoenix" } as never))).toBe("ok")
        expect(await code(() => office.savePropertyDetails(1, { timeZone: null } as never))).toBe("ok")
        expect(await code(() => office.saveTenantDetails(1, {} as never))).toBe("ok")
    })

    describe("compliance warnings", () => {
        const make = (settings: Record<string, unknown>, rules: unknown[] = [], deposits: unknown[] = []) => {
            const s = {
                compliance: vi.fn(async () => ({ securityDepositMaxMonths: null, lateFeeGraceDays: null, lateFeeMaxPercent: null, ...settings })),
                saveCompliance: vi.fn(async () => undefined),
                listCurrentDeposits: vi.fn(async () => deposits),
                listLateFeeRulesForCompliance: vi.fn(async () => rules),
            }
            return { s, office: new OfficeService(store(s), "America/Denver") }
        }

        it("none when no limits are set", async () => {
            const { s, office } = make({})
            expect(await office.complianceWarnings()).toEqual([])
            expect(s.listCurrentDeposits).not.toHaveBeenCalled()
            expect(s.listLateFeeRulesForCompliance).not.toHaveBeenCalled()
            await office.saveCompliance({} as never, true)
            expect(s.saveCompliance).toHaveBeenCalledWith({}, true)
            expect((await office.compliance()).lateFeeGraceDays).toBeNull()
        })

        it("deposits above the limit, in months (one or more)", async () => {
            const deposits = [{ unitId: 1, unitLabel: "W 101", monthlyRent: 1000, deposits: 1500 }, { unitId: 2, unitLabel: "W 102", monthlyRent: 1000, deposits: 1000 }]
            expect((await make({ securityDepositMaxMonths: 1 }, [], deposits).office.complianceWarnings()).map((w) => w.message))
                .toEqual(["W 101: deposits of $1,500.00 are more than 1 month of rent ($1,000.00)."])
            expect((await make({ securityDepositMaxMonths: 1.25 }, [], deposits).office.complianceWarnings())[0]!.message).toContain("1.25 months")
        })

        it("grace periods too short and late fees too high, flat, percent or unlimited", async () => {
            const rule = { unitId: 1, label: "Woodcrest", graceDays: 1, lowestRent: 1000, maxAmount: null, maxType: "flat" }
            const rules = [
                rule,
                { ...rule, unitId: 2, graceDays: 5, maxAmount: 200 },
                { ...rule, unitId: 3, graceDays: 5, maxAmount: 5, maxType: "percent" },
                { ...rule, unitId: 4, graceDays: 5, maxAmount: 100 },
                { ...rule, unitId: 5, graceDays: 5, lowestRent: null },
            ]
            const warnings = await make({ lateFeeGraceDays: 3, lateFeeMaxPercent: 10 }, rules).office.complianceWarnings()
            expect(warnings.map((w) => [w.code, w.unitId])).toEqual([["grace_below_min", 1], ["late_fee_above_max", 1], ["late_fee_above_max", 2]])
            expect(warnings[0]!.message).toBe("Woodcrest: the late fee rule charges after 1 day; your grace period is 3.")
            expect(warnings[1]!.message).toContain("has no limit")
            expect(warnings[2]!.message).toContain("can reach $200.00")
            const graceOnly = await make({ lateFeeGraceDays: 3 }, [{ ...rule, graceDays: 2 }]).office.complianceWarnings()
            expect(graceOnly.map((w) => w.message)).toEqual(["Woodcrest: the late fee rule charges after 2 days; your grace period is 3."])
            expect(await make({ lateFeeMaxPercent: 10 }, [{ ...rule, graceDays: 0, maxAmount: 50 }]).office.complianceWarnings()).toEqual([])
        })
    })

    describe("reports", () => {
        const s = {
            rentRollRows: vi.fn(async () => [{ portfolio: "A", property: "P", unit: "101", residents: "Ana", rent: 950, start: "2026-01-01", end: null, balance: 0, status: "current", openRequests: 1 }]),
            tenantRows: vi.fn(async () => [{ name: "Ana", email: "a@x.com", phone: null, unit: "101", signedUp: true, balance: 10, insurance: "not_provided", insuranceExpires: null, emergencyName: null, emergencyPhone: null }]),
            paymentRows: vi.fn(async () => [{ at: "2026-11-01", property: "P", unit: "101", residents: "Ana", amount: 950, type: "charge", status: "succeeded", method: "card", confirmation: "C1" },
                { at: "2026-11-02", property: "P", unit: "101", residents: "Ana", amount: -5, type: "refund", status: "succeeded", method: "card", confirmation: "C2" }]),
            chargeRows: vi.fn(async () => [{ due: "2026-11-01", property: "P", unit: "101", residents: "Ana", kind: "rent", description: "Rent", amount: 950 }]),
            expenseRows: vi.fn(async () => [{ date: "2026-11-01", property: null, unit: null, category: "repairs", vendor: null, description: "Fix", amount: 80 }]),
            maintenanceRows: vi.fn(async () => [
                { id: 1, opened: "2026-11-01", property: "P", unit: "101", title: "Leak", type: "plumbing", priority: "high", status: "in_progress", completed: null, assigned: "Luis", labor: 50, materials: null },
                { id: 2, opened: "2026-11-01", property: "P", unit: "101", title: "Door", type: "other", priority: "low", status: "submitted", completed: null, assigned: null, labor: null, materials: null },
            ]),
            incomeByPropertyRows: vi.fn(async () => [{ property: "P", collected: 1000, expenses: 250.5 }]),
        }
        const office = new OfficeService(store(s), "America/Denver")
        const lines = async (key: string, params = {}) => {
            const out = await office.exportCsv(key, params)
            return { filename: out.filename, lines: out.csv.slice(1).split("\r\n") }
        }

        it("lists eight reports", () => {
            expect(office.reports().map((r) => r.key)).toEqual(["rent-roll", "tenants", "payments", "charges", "expenses", "maintenance", "income-by-property", "portfolios"])
        })

        it("writes each report's rows", async () => {
            expect((await lines("rent-roll")).lines[1]).toBe("A,P,101,Ana,950.00,2026-01-01,,0.00,current,1")
            expect((await lines("tenants")).lines[1]).toBe("Ana,a@x.com,,101,yes,10.00,not provided,,,")
            const pay = await lines("payments", { from: "2026-11-01", to: "2026-11-30" })
            expect(pay.filename).toBe("payments-2026-11-01_to_2026-11-30.csv")
            expect(pay.lines.slice(1, 3).map((l) => l.split(",")[5])).toEqual(["payment", "refund"])
            expect((await lines("charges")).lines[1]).toBe("2026-11-01,P,101,Ana,rent,Rent,950.00")
            expect((await lines("expenses")).lines[1]).toBe("2026-11-01,All properties,,repairs,,Fix,80.00")
            const m = await lines("maintenance")
            expect(m.lines[1]).toBe("1,2026-11-01,P,101,Leak,plumbing,high,in progress,,Luis,50.00,,50.00")
            expect(m.lines[2]!.endsWith(",,,")).toBe(true)
            const income = await lines("income-by-property", { year: 2025 })
            expect(income.filename).toBe("income-by-property-2025.csv")
            expect(income.lines[1]).toBe("P,1000.00,250.50,749.50")
            expect((await lines("income-by-property")).filename).toMatch(/^income-by-property-20\d\d\.csv$/)
        })

        it("refuses an unknown report and a backwards date range", async () => {
            expect(await code(() => office.exportCsv("nope", {}))).toBe("NOT_FOUND")
            expect(await code(() => office.exportCsv("payments", { from: "2026-12-01", to: "2026-11-01" }))).toBe("VALIDATION_ERROR")
        })
    })

    it("search: at least two characters, digits for phone numbers, and maintenance staff see requests only", async () => {
        const s = { search: vi.fn(async () => []) }
        const office = new OfficeService(store(s), "America/Denver")
        expect(await office.search(" a ", "admin")).toEqual([])
        expect(s.search).not.toHaveBeenCalled()
        await office.search("  (505)  555-0100 ", "admin")
        expect(s.search).toHaveBeenLastCalledWith("(505) 555-0100", "5055550100", false)
        await office.search("leak", "maintenance_staff")
        expect(s.search).toHaveBeenLastCalledWith("leak", "", true)
    })
})

describe("LeasingService", () => {
    const s = {
        listListings: vi.fn(async () => []),
        findListing: vi.fn(async () => null as unknown),
        listLeads: vi.fn(async () => []),
        createListing: vi.fn(async () => 3),
        updateListing: vi.fn(async () => undefined),
        setListingStatus: vi.fn(async () => undefined),
        removeDraftListing: vi.fn(async () => undefined),
        addLead: vi.fn(async () => 8),
        setLeadStatus: vi.fn(async () => undefined),
        publicListings: vi.fn(async () => []),
        publicListingPhoto: vi.fn(async () => null as unknown),
        publicInquire: vi.fn(async () => null as number | null),
    }
    const leasing = new LeasingService(store(s))

    it("says Zillow is not connected", async () => {
        expect((await leasing.listings()).zillow.status).toBe("not_connected")
    })

    it("NOT_FOUND for a missing listing, photo, or a home no longer listed", async () => {
        await expect(leasing.listing(1)).rejects.toMatchObject({ code: "NOT_FOUND" })
        await expect(leasing.publicPhoto(1, 2)).rejects.toMatchObject({ code: "NOT_FOUND" })
        await expect(leasing.inquire(1, { name: "A" } as never)).rejects.toMatchObject({ code: "NOT_FOUND" })
        s.findListing.mockResolvedValueOnce({ id: 1 })
        s.publicListingPhoto.mockResolvedValueOnce({ data: Buffer.alloc(1) })
        s.publicInquire.mockResolvedValueOnce(4)
        expect(await leasing.listing(1)).toEqual({ id: 1, leadList: [] })
        expect(await leasing.publicPhoto(1, 2)).toEqual({ data: Buffer.alloc(1) })
        expect(await leasing.inquire(1, { name: "A" } as never)).toBe(4)
    })

    it("passes each change to the store", async () => {
        await runAs(admin, async () => {
            expect(await leasing.create(1, {} as never)).toBe(3)
            await leasing.update(3, {} as never)
            await leasing.publish(3)
            await leasing.end(3)
            await leasing.removeDraft(3)
            expect(await leasing.addLead(3, {} as never)).toBe(8)
            await leasing.setLeadStatus(8, "closed")
        })
        await leasing.publish(3)            // no one signed in: logged as anonymous
        expect((s.setListingStatus.mock.calls as unknown[][]).map((c) => c[1])).toEqual(["active", "ended", "active"])
        expect(await leasing.leads()).toEqual([])
        expect(await leasing.publicListings()).toEqual([])
    })
})

describe("MaintenanceDetailService", () => {
    const day = 86_400_000
    const now = Date.now()
    const s = {
        maintenanceDetail: vi.fn(async () => null as unknown),
        maintenanceForSummary: vi.fn(async () => [
            { recent: true, open: false, status: "resolved", priority: "high", requestType: "plumbing", createdAt: new Date(now - 4 * day), completedAt: new Date(now - 2 * day) },
            { recent: true, open: false, status: "resolved", priority: "low", requestType: "plumbing", createdAt: new Date(now - 5 * day), completedAt: new Date(now - 4 * day) },
            { recent: true, open: true, status: "submitted", priority: "high", requestType: "hvac", createdAt: new Date(now - day), completedAt: null },
            { recent: false, open: true, status: "in_progress", priority: "none", requestType: "other", createdAt: new Date(now - 90 * day), completedAt: null },
            { recent: false, open: false, status: "resolved", priority: "none", requestType: "other", createdAt: new Date(now - 90 * day), completedAt: new Date(now - 60 * day) },
            { recent: false, open: false, status: "resolved", priority: "none", requestType: "other", createdAt: new Date(now - 90 * day), completedAt: null },
        ]),
        updateMaintenanceWork: vi.fn(async () => undefined),
        addMaintenanceNote: vi.fn(async () => 2),
        addMaintenancePhoto: vi.fn(async () => 6),
        maintenancePhoto: vi.fn(async () => null as unknown),
        recordMaintenanceExpense: vi.fn(async () => 11),
        tenantPhotos: vi.fn(async () => ({ "1": [] })),
    }
    const service = new MaintenanceDetailService(store(s), "America/Denver")
    const photo = { filename: "p.png", data: PNG.toString("base64") }

    it("NOT_FOUND for a missing request or photo", async () => {
        await expect(service.detail(1)).rejects.toMatchObject({ code: "NOT_FOUND" })
        await expect(service.photo(1, 2)).rejects.toMatchObject({ code: "NOT_FOUND" })
        s.maintenanceDetail.mockResolvedValueOnce({ id: 1 })
        s.maintenancePhoto.mockResolvedValueOnce({ filename: "p" })
        expect(await service.detail(1)).toEqual({ id: 1 })
        expect(await service.photo(1, 2)).toEqual({ filename: "p" })
    })

    it("sums the queue: counts of recent requests, what is open and the average days to complete", async () => {
        expect(await service.summary(30)).toEqual({
            days: 30, byStatus: { resolved: 2, submitted: 1 }, byPriority: { high: 2, low: 1 }, byType: { plumbing: 2, hvac: 1 }, open: 2, averageDaysToComplete: 1.5,
        })
        s.maintenanceForSummary.mockResolvedValueOnce([])
        expect((await service.summary(7)).averageDaysToComplete).toBeNull()
    })

    it("photos: staff for staff, residents for residents", async () => {
        expect(() => service.addStaffPhoto(1, photo)).toThrow("FORBIDDEN")
        expect(() => runAs(tenantWho, () => service.addStaffPhoto(1, photo))).toThrow("FORBIDDEN")
        expect(() => runAs(admin, () => service.addTenantPhoto(1, photo))).toThrow("FORBIDDEN")
        expect(await runAs(admin, () => service.addStaffPhoto(1, photo))).toBe(6)
        expect(s.addMaintenancePhoto).toHaveBeenLastCalledWith(1, expect.objectContaining({ contentType: "image/png" }), { adminId: 1 })
        expect(await runAs(tenantWho, () => service.addTenantPhoto(1, photo))).toBe(6)
        expect(s.addMaintenancePhoto).toHaveBeenLastCalledWith(1, expect.anything(), { tenantId: 7 })
    })

    it("asks for tenant photos only when there are requests, and passes the rest through", async () => {
        expect(await service.tenantPhotos([])).toEqual({})
        expect(s.tenantPhotos).not.toHaveBeenCalled()
        expect(await service.tenantPhotos([1])).toEqual({ "1": [] })
        await runAs(admin, async () => {
            await service.updateWork(1, {} as never)
            expect(await service.addNote(1, "hi")).toBe(2)
            expect(await service.recordExpense(1)).toBe(11)
        })
        expect((s.recordMaintenanceExpense.mock.calls as unknown[][])[0]![1]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
})

describe("NoticesService", () => {
    const shared = [
        { id: 3, kind: "document", title: "Inspection", filename: "i.pdf", uploadedAt: "2026-10-01", href: "/x", category: "inspection" },
        { id: 4, kind: "document", title: "Addendum", filename: "a.pdf", uploadedAt: "2026-10-02", href: "/y", category: "lease" },
    ]
    const s = {
        listNotices: vi.fn(async () => []),
        sendNotice: vi.fn(async () => ({ recipients: 12, emailsQueued: 0, emailsSkipped: 0 })),
        tenantNotices: vi.fn(async () => []),
        markNoticeRead: vi.fn(async () => undefined),
        listHubDocuments: vi.fn(async () => []),
        addDocument: vi.fn(async () => 5),
        updateDocument: vi.fn(async () => undefined),
        hideDocument: vi.fn(async () => undefined),
        documentFile: vi.fn(async () => null as unknown),
        tenantDocuments: vi.fn(async () => shared),
    }
    const leases = { findCurrentLease: vi.fn(async () => ({ id: 2 }) as { id: number } | null), findLeaseDocumentMeta: vi.fn(async () => ({ filename: "lease.pdf", uploadedAt: new Date("2026-01-01T00:00:00Z") }) as never) }
    const notices = new NoticesService(store(s), leases, "America/Denver")

    it("in-app only: no emails go out", async () => {
        expect(notices.emailEnabled).toBe(false)
        // Asked to email, but no email is set up: in the portal only.
        expect(await runAs(admin, () => notices.send({ kind: "all" } as never, "Hi", "Body", true))).toEqual({ recipients: 12, emailsQueued: 0, emailsSkipped: 0 })
        expect(s.sendNotice).toHaveBeenLastCalledWith({ kind: "all" }, "Hi", "Body", expect.any(String), false)
        expect(await notices.notices({} as never)).toEqual([])
        expect(await notices.tenantNotices()).toEqual([])
        await notices.markRead(1)
        expect(s.markNoticeRead).toHaveBeenCalledWith(1)
    })

    it("documents: upload checks the file; a missing file is NOT_FOUND", async () => {
        const input = { scope: "unit", scopeId: 1, category: "other", title: "T", sharedWithTenant: false } as const
        expect(() => notices.upload({ ...input, file: { data: PNG.subarray(0, 4).toString("base64") } })).toThrow()
        expect(await runAs(admin, () => notices.upload({ ...input, file: { filename: "a.pdf", data: PDF.toString("base64") } }))).toBe(5)
        await notices.update(5, {} as never)
        await notices.hide(5)
        expect(await notices.hub({} as never)).toEqual([])
        await expect(notices.file(5)).rejects.toMatchObject({ code: "NOT_FOUND" })
        s.documentFile.mockResolvedValueOnce({ filename: "a.pdf" })
        expect(await notices.file(5)).toEqual({ filename: "a.pdf" })
    })

    it("groups a resident's documents, with their signed lease first", async () => {
        const groups = await notices.tenantDocuments(7)
        expect(groups.map((g) => g.category)).toEqual(["lease", "inspection", "insurance", "notice", "receipt", "other"])
        expect(groups[0]!.documents.map((d) => d.title)).toEqual(["Your signed lease", "Addendum"])
        expect(groups[1]!.documents).toEqual([{ id: 3, kind: "document", title: "Inspection", filename: "i.pdf", uploadedAt: "2026-10-01", href: "/x" }])
        leases.findLeaseDocumentMeta.mockResolvedValueOnce(null as never)
        expect((await notices.tenantDocuments(7))[0]!.documents.map((d) => d.title)).toEqual(["Addendum"])
        leases.findCurrentLease.mockResolvedValueOnce(null)
        expect((await notices.tenantDocuments(7))[0]!.documents.map((d) => d.title)).toEqual(["Addendum"])
    })
})
