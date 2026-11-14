import { Router, type Response } from "express"

import type { Auth } from "../middleware/auth"
import type { RateLimits } from "../middleware/rate-limit"
import { REPORT_KEYS, type OfficeService } from "../services/office-service"
import { isStaffRole, type ValidRequest } from "../types/access"
import type { ActivityFilter, ComplianceInput, InsuranceStatus } from "../types/additions"
import { AppError } from "../types/errors"
import { date, email, id, text } from "./validate"

/**
 * /api/manager office tools (009). Property managers, except search, which
 * maintenance staff use too (they only get maintenance results).
 *
 *   GET    /manager/team                                  everyone with an office sign-in
 *   POST   /manager/team             { name, email, role }  → { id, inviteLink, expiresAt }
 *   PUT    /manager/team/:id         { name?, role? }
 *   DELETE /manager/team/:id                              deactivate (signed out everywhere)
 *   POST   /manager/team/:id/invite                       a new sign-up link (not signed up yet)
 *   POST   /manager/team/:id/reset                        reset sign-in: a link to choose a new password
 *   GET    /manager/activity[.csv]?kind=&table=&since=&limit=   the change log and sign-ins
 *   GET    /manager/portfolios                            portfolios with numbers, and properties in none
 *   POST   /manager/portfolios       { name, entityName?, notes? }
 *   PUT    /manager/portfolios/:id   { name, entityName?, notes? }
 *   DELETE /manager/portfolios/:id                        retire (its properties are unassigned)
 *   GET|PUT /manager/properties/:id/details               portfolio, city, state, ZIP, time zone, notes
 *   GET|PUT /manager/tenants/:id/details                  insurance, emergency contact, notes
 *   GET|PUT /manager/compliance        PUT { ...settings, confirm }
 *   GET    /manager/compliance/warnings
 *   GET    /manager/reports                               the downloads
 *   GET    /manager/export/:key.csv?from=&to=&year=
 *   GET    /manager/search?q=
 */
export function createOfficeRouter(deps: { office: OfficeService; guard: Auth; limits: RateLimits; webOrigin: string }): Router {
    const { office, guard, limits } = deps
    const { can } = guard
    const router = Router()
    const link = (token: string) => `${deps.webOrigin.replace(/\/$/, "")}/signup?token=${encodeURIComponent(token)}`
    const role = (value: unknown) => {
        if (typeof value !== "string" || !isStaffRole(value)) throw new AppError("VALIDATION_ERROR")
        return value
    }
    const optionalText = (value: unknown, max: number) => text(value, max, { optional: true })
    const nullableBool = (value: unknown) => {
        if (value === null || value === undefined) return null
        if (typeof value !== "boolean") throw new AppError("VALIDATION_ERROR")
        return value
    }
    const nullableNumber = (value: unknown, min: number, max: number, integer = false) => {
        if (value === null || value === undefined || value === "") return null
        if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new AppError("VALIDATION_ERROR")
        return value
    }
    const sendCsv = (res: Response, filename: string, csv: string) => {
        res.set({
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.-]/g, "_")}"`,
            "Cache-Control": "private, no-store",
        })
        res.send(csv)
    }

    /* ---- Team ---- */

    router.get("/manager/team", ...can("users:provision"), async (_req, res) => {
        res.json({ team: await office.team() })
    })

    router.post("/manager/team", limits.sensitive, ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        const invite = await office.invite({ name: text(body.name, 255)!, email: email(body.email), role: role(body.role) })
        res.status(201).json({ id: invite.id, inviteLink: link(invite.inviteToken), expiresAt: invite.expiresAt })
    })

    router.put("/manager/team/:id", limits.sensitive, ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        await office.updateMember(id(req.params.id), {
            ...(body.name !== undefined ? { name: text(body.name, 255)! } : {}),
            ...(body.role !== undefined ? { role: role(body.role) } : {}),
        })
        res.json({ ok: true })
    })

    router.delete("/manager/team/:id", limits.sensitive, ...can("users:provision"), async (req, res) => {
        await office.deactivate(id(req.params.id))
        res.json({ ok: true })
    })

    router.post("/manager/team/:id/invite", limits.sensitive, ...can("users:provision"), async (req, res) => {
        const invite = await office.reissueInvite(id(req.params.id))
        res.json({ inviteLink: link(invite.inviteToken), expiresAt: invite.expiresAt })
    })

    router.post("/manager/team/:id/reset", limits.sensitive, ...can("users:provision"), async (req, res) => {
        const invite = await office.resetSignIn(id(req.params.id))
        res.json({ inviteLink: link(invite.inviteToken), expiresAt: invite.expiresAt })
    })

    /* ---- Activity ---- */

    const activityFilter = (q: Record<string, unknown>, maxLimit: number): ActivityFilter => {
        const kind = q.kind === "change" || q.kind === "security" ? q.kind : q.kind === undefined || q.kind === "" ? null : (() => { throw new AppError("VALIDATION_ERROR") })()
        const table = typeof q.table === "string" && q.table ? q.table : null
        if (table !== null && !/^[a-z_]{1,40}$/.test(table)) throw new AppError("VALIDATION_ERROR")
        const since = typeof q.since === "string" && q.since ? q.since : null
        if (since !== null && Number.isNaN(Date.parse(since))) throw new AppError("VALIDATION_ERROR")
        const limit = q.limit === undefined ? 200 : Number(q.limit)
        if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) throw new AppError("VALIDATION_ERROR")
        return { kind, table, since: since === null ? null : new Date(since).toISOString(), limit }
    }

    router.get("/manager/activity", ...can("users:provision"), async (req, res) => {
        res.json({ entries: await office.activity(activityFilter(req.query as Record<string, unknown>, 1000)) })
    })

    router.get("/manager/activity.csv", ...can("users:provision"), async (req, res) => {
        sendCsv(res, `activity-${new Date().toISOString().slice(0, 10)}.csv`, await office.activityCsv(activityFilter(req.query as Record<string, unknown>, 5000)))
    })

    /* ---- Portfolios and details ---- */

    const portfolio = (body: Record<string, unknown>) => ({ name: text(body.name, 120)!, entityName: optionalText(body.entityName, 200), notes: optionalText(body.notes, 2000) })

    router.get("/manager/portfolios", ...can("ledger:read:property"), async (_req, res) => {
        res.json(await office.portfolios())
    })

    router.post("/manager/portfolios", limits.sensitive, ...can("users:provision"), async (req, res) => {
        res.status(201).json({ id: await office.savePortfolio(null, portfolio(req.body as Record<string, unknown>)) })
    })

    router.put("/manager/portfolios/:id", limits.sensitive, ...can("users:provision"), async (req, res) => {
        res.json({ id: await office.savePortfolio(id(req.params.id), portfolio(req.body as Record<string, unknown>)) })
    })

    router.delete("/manager/portfolios/:id", limits.sensitive, ...can("users:provision"), async (req, res) => {
        await office.retirePortfolio(id(req.params.id))
        res.json({ ok: true })
    })

    router.get("/manager/properties/:id/details", ...can("ledger:read:property"), async (req, res) => {
        res.json(await office.propertyDetails(id(req.params.id)))
    })

    router.put("/manager/properties/:id/details", limits.sensitive, ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        const state = optionalText(body.state, 2)
        const zip = optionalText(body.zip, 10)
        if (state !== null && !/^[A-Za-z]{2}$/.test(state)) throw new AppError("VALIDATION_ERROR")
        if (zip !== null && !/^\d{5}(-\d{4})?$/.test(zip)) throw new AppError("VALIDATION_ERROR")
        await office.savePropertyDetails(id(req.params.id), {
            portfolioId: body.portfolioId === null || body.portfolioId === undefined ? null : id(body.portfolioId),
            city: optionalText(body.city, 80),
            state: state?.toUpperCase() ?? null,
            zip,
            timeZone: optionalText(body.timeZone, 40),
            notes: optionalText(body.notes, 4000),
        })
        res.json({ ok: true })
    })

    const INSURANCE: InsuranceStatus[] = ["not_required", "required", "on_file", "expired"]

    router.get("/manager/tenants/:id/details", ...can("ledger:read:property"), async (req, res) => {
        res.json(await office.tenantDetails(id(req.params.id)))
    })

    router.put("/manager/tenants/:id/details", limits.sensitive, ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        if (!INSURANCE.includes(body.insuranceStatus as InsuranceStatus)) throw new AppError("VALIDATION_ERROR")
        const phone = optionalText(body.emergencyContactPhone, 40)
        if (phone !== null && !/^[0-9+().\-\s]{7,40}$/.test(phone)) throw new AppError("VALIDATION_ERROR")
        await office.saveTenantDetails(id(req.params.id), {
            insuranceStatus: body.insuranceStatus as InsuranceStatus,
            insuranceExpires: date(body.insuranceExpires, { optional: true }),
            emergencyContactName: optionalText(body.emergencyContactName, 120),
            emergencyContactPhone: phone,
            notes: optionalText(body.notes, 4000),
        })
        res.json({ ok: true })
    })

    /* ---- Compliance ---- */

    router.get("/manager/compliance", ...can("ledger:read:property"), async (_req, res) => {
        res.json(await office.compliance())
    })

    router.put("/manager/compliance", limits.sensitive, ...can("users:provision"), async (req, res) => {
        const body = req.body as Record<string, unknown>
        if (typeof body.state !== "string" || !/^[A-Za-z]{2}$/.test(body.state.trim())) throw new AppError("VALIDATION_ERROR")
        const months = nullableNumber(body.securityDepositMaxMonths, 0.1, 12)
        if (months !== null && Math.round(months * 10) !== months * 10) throw new AppError("VALIDATION_ERROR")
        const input: ComplianceInput = {
            state: body.state.trim().toUpperCase(),
            securityDepositMaxMonths: months,
            depositInterestRequired: nullableBool(body.depositInterestRequired),
            lateFeeGraceDays: nullableNumber(body.lateFeeGraceDays, 0, 60, true),
            lateFeeMaxPercent: nullableNumber(body.lateFeeMaxPercent, 0, 100),
            noticeToQuitDays: nullableNumber(body.noticeToQuitDays, 0, 3650, true),
            rentIncreaseNoticeDays: nullableNumber(body.rentIncreaseNoticeDays, 0, 3650, true),
            leadPaintDisclosureRequired: nullableBool(body.leadPaintDisclosureRequired),
            notes: optionalText(body.notes, 4000),
            references: optionalText(body.references, 4000),
        }
        await office.saveCompliance(input, body.confirm === true)
        res.json({ ok: true })
    })

    router.get("/manager/compliance/warnings", ...can("ledger:read:property"), async (_req, res) => {
        res.json({ warnings: await office.complianceWarnings() })
    })

    /* ---- Reports ---- */

    router.get("/manager/reports", ...can("ledger:read:property"), (_req, res) => {
        res.json({ reports: office.reports() })
    })

    router.get("/manager/export/:file", ...can("ledger:read:property"), async (req, res) => {
        const key = /^([a-z-]+)\.csv$/.exec(String(req.params.file))?.[1]
        if (!key || !REPORT_KEYS.includes(key)) throw new AppError("NOT_FOUND")
        const q = req.query as Record<string, unknown>
        const year = q.year === undefined || q.year === "" ? null : Number(q.year)
        if (year !== null && (!Number.isInteger(year) || year < 2000 || year > 2100)) throw new AppError("VALIDATION_ERROR")
        const { filename, csv } = await office.exportCsv(key, { from: date(q.from, { optional: true }), to: date(q.to, { optional: true }), year })
        sendCsv(res, filename, csv)
    })

    /* ---- Search ---- */

    router.get("/manager/search", ...can("maintenance:manage"), async (req: ValidRequest, res) => {
        const q = typeof req.query.q === "string" ? req.query.q : ""
        const who = req.user!.role
        res.json({ hits: await office.search(q, who === "maintenance_staff" ? "maintenance_staff" : "admin") })
    })

    return router
}
