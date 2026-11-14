import { currentIdentity } from "../db/identity"
import { silentLogger, type LogMetadata, type LogService } from "../logging"
import type { StaffRole } from "../types/access"
import type {
    ActivityEntry, ActivityFilter, ComplianceInput, ComplianceSettings, ComplianceWarning, PortfolioInput, PropertyDetails,
    PropertyDetailsInput, ReportInfo, SearchHit, TeamMember, TenantDetails, TenantDetailsInput,
} from "../types/additions"
import { AppError } from "../types/errors"
import type { AdditionsStore } from "../types/stores"
import { csvMoney, toCsv } from "../utils/csv"
import { newInvite } from "../utils/tokens"
import { localDate } from "./ledger"

/** How the Activity page names each table it shows. */
const TABLE_NAMES: Record<string, string> = {
    payment: "Payment", charge: "Charge", lease: "Lease", lease_tenants: "Lease resident", tenants: "Tenant", maintenance_t: "Maintenance request",
    expenses: "Expense", admin: "Staff account", late_fee_rules: "Late fee rule", rent_reminder_rules: "Rent reminder rule", office_settings: "Office settings",
    property: "Property", units: "Unit", payment_details: "Payment details", payment_reviews: "Payment review", reported_payments: "Reported payment",
    lease_documents: "Lease document", property_images: "Property photo", portfolios: "Portfolio", tenant_details: "Tenant details",
    compliance_settings: "Compliance settings", maintenance_notes: "Maintenance note", maintenance_attachments: "Maintenance photo",
    documents: "Document", notifications_sent: "Notice", listings: "Listing", leads: "Lead",
}
/** Columns that change on every save and say nothing on their own. */
const NOISE = new Set(["updated_at", "public_id"])

const short = (value: unknown) => {
    const text = value === null || value === undefined || value === "" ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value)
    return text.length > 40 ? `${text.slice(0, 39)}…` : text
}

/** "Property 1 created", "Lease 4: end_date — → 2026-12-31; monthly_rent 950 → 975". */
export function auditSummary(table: string, rowPk: string, action: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): string {
    const name = `${TABLE_NAMES[table] ?? table} ${rowPk}`.trim()
    if (action === "INSERT") return `${name} created`
    if (action === "DELETE") return `${name} deleted`
    const changes = Object.keys(after ?? {})
        .filter((k) => !NOISE.has(k) && JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]))
        .map((k) => `${k} ${short(before?.[k])} → ${short(after?.[k])}`)
    return changes.length ? `${name}: ${changes.slice(0, 6).join("; ")}${changes.length > 6 ? ` (+${changes.length - 6} more)` : ""}` : `${name} updated`
}

const REPORTS: ReportInfo[] = [
    { key: "rent-roll", name: "Rent roll", description: "Every unit: portfolio, residents, rent, lease dates, balance and status, as of today.", href: "/export/rent-roll.csv", filters: [] },
    { key: "tenants", name: "Tenants", description: "Everyone with a portal account: contact details, unit, balance, insurance and emergency contact.", href: "/export/tenants.csv", filters: [] },
    { key: "payments", name: "Payments", description: "Money received and refunded in a date range, with method and confirmation number.", href: "/export/payments.csv", filters: ["from", "to"] },
    { key: "charges", name: "Charges", description: "Rent, fees and other charges due in a date range.", href: "/export/charges.csv", filters: ["from", "to"] },
    { key: "expenses", name: "Expenses", description: "Costs recorded in a date range, by property and category.", href: "/export/expenses.csv", filters: ["from", "to"] },
    { key: "maintenance", name: "Maintenance", description: "Requests opened in a date range: stage, who it was assigned to, and the cost.", href: "/export/maintenance.csv", filters: ["from", "to"] },
    { key: "income-by-property", name: "Income and expenses by property", description: "Money collected, expenses and net for each property in a year (for Schedule E).", href: "/export/income-by-property.csv", filters: ["year"] },
    { key: "portfolios", name: "Portfolios", description: "Each portfolio with its properties, units, occupancy, rent and what is owed.", href: "/export/portfolios.csv", filters: [] },
]
export const REPORT_KEYS = REPORTS.map((r) => r.key)

/** Search: a phone number's digits, a name, an email, a unit number... at least 2 characters. */
export const SEARCH_MIN_LENGTH = 2

/**
 * Office tools (009): the team, the activity log, portfolios, property and
 * tenant details, compliance settings and warnings, report downloads and the
 * search box. Staff only (the routes check; row-level security agrees).
 */
export class OfficeService {
    constructor(
        private readonly db: AdditionsStore,
        private readonly timeZone: string,
        private readonly log: LogService = silentLogger,
    ) {}

    private today() {
        return localDate(new Date(), this.timeZone)
    }

    private actor(): string | null {
        const who = currentIdentity()
        return "id" in who ? `${who.type}:${who.id}` : who.type === "system" ? "system" : null
    }

    private selfId(): number | null {
        const who = currentIdentity()
        return who.type === "admin" ? who.id : null
    }

    private change<T>(event: string, metadata: LogMetadata, work: () => Promise<T>): Promise<T> {
        return this.log.flow(event, { by: this.actor() ?? "unknown", ...metadata }, work)
    }

    /* ---- Team ---- */

    team(): Promise<TeamMember[]> {
        return this.db.listTeam()
    }

    invite(input: { name: string; email: string; role: StaffRole }): Promise<{ id: number; inviteToken: string; expiresAt: string }> {
        return this.change("office.team.invite", { role: input.role }, async () => {
            const fresh = newInvite()
            const id = await this.db.inviteStaff({ ...input, invite: fresh.hash })
            await this.db.recordSecurityEvent(this.actor(), "team_invite", `Invited ${input.name} (${input.role === "admin" ? "property manager" : "maintenance"})`, { adminId: id, email: input.email })
            return { id, inviteToken: fresh.token, expiresAt: fresh.hash.expiresAt.toISOString() }
        })
    }

    updateMember(id: number, input: { name?: string; role?: StaffRole }): Promise<void> {
        return this.change("office.team.update", { adminId: id }, async () => {
            const member = await this.db.findTeamMember(id)
            if (!member || member.status === "deactivated") throw new AppError("NOT_FOUND")
            if (input.role !== undefined && input.role !== member.role) {
                if (id === this.selfId()) throw new AppError("SELF_CHANGE_FORBIDDEN")
                if (member.role === "admin" && member.status === "active" && (await this.db.countOtherActiveManagers(id)) === 0) throw new AppError("LAST_ADMIN")
            }
            await this.db.updateStaff(id, input)
            const what = [input.name !== undefined && input.name !== member.name ? `name to ${input.name}` : null, input.role !== undefined && input.role !== member.role ? `role to ${input.role}` : null].filter(Boolean)
            if (what.length) await this.db.recordSecurityEvent(this.actor(), "team_update", `Changed ${member.name}'s ${what.join(" and ")}`, { adminId: id })
        })
    }

    deactivate(id: number): Promise<void> {
        return this.change("office.team.deactivate", { adminId: id }, async () => {
            if (id === this.selfId()) throw new AppError("SELF_CHANGE_FORBIDDEN")
            const member = await this.db.findTeamMember(id)
            if (!member || member.status === "deactivated") throw new AppError("NOT_FOUND")
            if (member.role === "admin" && member.status === "active" && (await this.db.countOtherActiveManagers(id)) === 0) throw new AppError("LAST_ADMIN")
            await this.db.deactivateStaff(id)
            await this.db.recordSecurityEvent(this.actor(), "team_deactivate", `Deactivated ${member.name}`, { adminId: id })
        })
    }

    reissueInvite(id: number): Promise<{ inviteToken: string; expiresAt: string }> {
        return this.change("office.team.reissue", { adminId: id }, async () => {
            const member = await this.db.findTeamMember(id)
            if (!member || member.status === "deactivated") throw new AppError("NOT_FOUND")
            const fresh = newInvite()
            await this.db.reissueStaffInvite(id, fresh.hash)
            await this.db.recordSecurityEvent(this.actor(), "team_reissue", `Made a new sign-up link for ${member.name}`, { adminId: id })
            return { inviteToken: fresh.token, expiresAt: fresh.hash.expiresAt.toISOString() }
        })
    }

    resetSignIn(id: number): Promise<{ inviteToken: string; expiresAt: string }> {
        return this.change("office.team.reset", { adminId: id }, async () => {
            if (id === this.selfId()) throw new AppError("SELF_CHANGE_FORBIDDEN")
            const member = await this.db.findTeamMember(id)
            if (!member || member.status === "deactivated") throw new AppError("NOT_FOUND")
            const fresh = newInvite()
            await this.db.resetStaffSignIn(id, fresh.hash)
            await this.db.recordSecurityEvent(this.actor(), "team_reset", `Reset ${member.name}'s sign-in`, { adminId: id })
            return { inviteToken: fresh.token, expiresAt: fresh.hash.expiresAt.toISOString() }
        })
    }

    /* ---- Activity ---- */

    async activity(filter: ActivityFilter): Promise<ActivityEntry[]> {
        // A sign-in stamps Admin.last_login_at; the sign-in itself is the entry that matters, so that stamp is left out.
        const changes = (filter.kind === "security" ? [] : await this.db.listAudit(filter.table, filter.since, filter.limit)).filter((c) => !onlyStampsLastLogin(c))
        const security = filter.kind === "change" || filter.table ? [] : await this.db.listSecurityEvents(filter.since, filter.limit)
        const names = await this.db.actorNames([...changes.map((c) => c.by ?? ""), ...security.map((s) => s.by ?? "")])
        const entries: ActivityEntry[] = [
            ...changes.map((c) => ({
                at: c.at, by: c.by, byName: names.get(c.by ?? "") ?? null, kind: "change" as const, table: c.table, rowPk: c.rowPk, action: c.action,
                summary: auditSummary(c.table, c.rowPk, c.action, c.before, c.after), details: { before: c.before, after: c.after },
            })),
            ...security.map((s) => ({
                at: s.at, by: s.by, byName: names.get(s.by ?? "") ?? null, kind: "security" as const, table: null, rowPk: null, action: s.action,
                summary: s.summary, details: s.details,
            })),
        ]
        return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, filter.limit)
    }

    async activityCsv(filter: ActivityFilter): Promise<string> {
        const rows = await this.activity(filter)
        return toCsv(["When", "Who", "Kind", "Record", "Action", "Summary"], rows.map((e) => [e.at, e.byName ?? e.by, e.kind, e.table ? `${e.table} ${e.rowPk}` : "", e.action, e.summary]))
    }

    /* ---- Portfolios and details ---- */

    async portfolios() {
        const [portfolios, unassigned] = await Promise.all([this.db.listPortfolios(), this.db.listUnassignedProperties()])
        return {
            portfolios: portfolios.map((f) => ({ ...f, propertyCount: f.properties.length, occupancy: f.units ? f.occupied / f.units : 0 })),
            unassigned,
        }
    }

    savePortfolio(id: number | null, input: PortfolioInput): Promise<number> {
        return this.change(id === null ? "office.portfolio.create" : "office.portfolio.update", { portfolioId: id }, () => this.db.savePortfolio(id, input))
    }

    retirePortfolio(id: number): Promise<void> {
        return this.change("office.portfolio.retire", { portfolioId: id }, () => this.db.retirePortfolio(id))
    }

    async propertyDetails(id: number): Promise<PropertyDetails> {
        const details = await this.db.propertyDetails(id)
        if (!details) throw new AppError("NOT_FOUND")
        return details
    }

    savePropertyDetails(id: number, input: PropertyDetailsInput): Promise<void> {
        if (input.timeZone !== null && !isTimeZone(input.timeZone)) throw new AppError("VALIDATION_ERROR")
        return this.change("office.property.details", { propertyId: id }, () => this.db.savePropertyDetails(id, input))
    }

    async tenantDetails(id: number): Promise<TenantDetails> {
        const details = await this.db.tenantDetails(id)
        if (!details) throw new AppError("NOT_FOUND")
        return details
    }

    saveTenantDetails(id: number, input: TenantDetailsInput): Promise<void> {
        return this.change("office.tenant.details", { tenantId: id }, () => this.db.saveTenantDetails(id, input))
    }

    /* ---- Compliance ---- */

    compliance(): Promise<ComplianceSettings> {
        return this.db.compliance()
    }

    saveCompliance(input: ComplianceInput, confirm: boolean): Promise<void> {
        return this.change("office.compliance.save", { confirm }, () => this.db.saveCompliance(input, confirm))
    }

    /** Current leases and late fee rules outside the office's own compliance values. */
    async complianceWarnings(): Promise<ComplianceWarning[]> {
        const settings = await this.db.compliance()
        const today = this.today()
        const warnings: ComplianceWarning[] = []
        if (settings.securityDepositMaxMonths !== null) {
            for (const d of await this.db.listCurrentDeposits(today)) {
                const max = Math.round(d.monthlyRent * settings.securityDepositMaxMonths * 100) / 100
                if (d.deposits > max) {
                    warnings.push({
                        code: "deposit_above_max", unitId: d.unitId,
                        message: `${d.unitLabel}: deposits of ${usd(d.deposits)} are more than ${settings.securityDepositMaxMonths} month${settings.securityDepositMaxMonths === 1 ? "" : "s"} of rent (${usd(max)}).`,
                    })
                }
            }
        }
        if (settings.lateFeeGraceDays !== null || settings.lateFeeMaxPercent !== null) {
            for (const r of await this.db.listLateFeeRulesForCompliance(today)) {
                if (settings.lateFeeGraceDays !== null && r.graceDays < settings.lateFeeGraceDays) {
                    warnings.push({
                        code: "grace_below_min", unitId: r.unitId,
                        message: `${r.label}: the late fee rule charges after ${r.graceDays} day${r.graceDays === 1 ? "" : "s"}; your grace period is ${settings.lateFeeGraceDays}.`,
                    })
                }
                if (settings.lateFeeMaxPercent !== null && r.lowestRent !== null) {
                    const limit = (r.lowestRent * settings.lateFeeMaxPercent) / 100
                    const cap = r.maxAmount === null ? null : r.maxType === "percent" ? (r.lowestRent * r.maxAmount) / 100 : r.maxAmount
                    if (cap === null || cap > limit + 0.005) {
                        warnings.push({
                            code: "late_fee_above_max", unitId: r.unitId,
                            message: cap === null
                                ? `${r.label}: the late fee rule has no limit; yours is ${settings.lateFeeMaxPercent}% of rent (${usd(limit)} on ${usd(r.lowestRent)}).`
                                : `${r.label}: late fees can reach ${usd(cap)}, more than ${settings.lateFeeMaxPercent}% of rent (${usd(limit)} on ${usd(r.lowestRent)}).`,
                        })
                    }
                }
            }
        }
        return warnings
    }

    /* ---- Reports ---- */

    reports(): ReportInfo[] {
        return REPORTS
    }

    /** The CSV for a report: { filename, csv }. Dates default to this month; the year to this year. */
    async exportCsv(key: string, params: { from?: string | null; to?: string | null; year?: number | null }): Promise<{ filename: string; csv: string }> {
        const today = this.today()
        const from = params.from ?? `${today.slice(0, 8)}01`
        const to = params.to ?? today
        if (from > to) throw new AppError("VALIDATION_ERROR")
        const range = `${from}_to_${to}`
        switch (key) {
            case "rent-roll": {
                const rows = await this.db.rentRollRows(today)
                return {
                    filename: `rent-roll-${today}.csv`,
                    csv: toCsv(["Portfolio", "Property", "Unit", "Residents", "Monthly rent", "Lease start", "Lease end", "Balance", "Status", "Open requests"],
                        rows.map((r) => [r.portfolio as string, r.property as string, r.unit as string, r.residents as string, csvMoney(r.rent as number | null),
                            r.start as string, r.end as string, csvMoney(r.balance as number), r.status as string, r.openRequests as number])),
                }
            }
            case "tenants": {
                const rows = await this.db.tenantRows(today)
                return {
                    filename: `tenants-${today}.csv`,
                    csv: toCsv(["Name", "Email", "Phone", "Unit", "Signed up", "Balance", "Renters insurance", "Insurance expires", "Emergency contact", "Emergency phone"],
                        rows.map((r) => [r.name as string, r.email as string, r.phone as string, r.unit as string, r.signedUp as boolean, csvMoney(r.balance as number),
                            String(r.insurance).replace(/_/g, " "), r.insuranceExpires as string, r.emergencyName as string, r.emergencyPhone as string])),
                }
            }
            case "payments": {
                const rows = await this.db.paymentRows(from, to, this.timeZone)
                return {
                    filename: `payments-${range}.csv`,
                    csv: toCsv(["Date", "Property", "Unit", "Residents", "Amount", "Type", "Status", "Method", "Confirmation"],
                        rows.map((r) => [r.at as string, r.property as string, r.unit as string, r.residents as string, csvMoney(r.amount as number),
                            r.type === "charge" ? "payment" : "refund", r.status as string, r.method as string, r.confirmation as string])),
                }
            }
            case "charges": {
                const rows = await this.db.chargeRows(from, to)
                return {
                    filename: `charges-${range}.csv`,
                    csv: toCsv(["Due date", "Property", "Unit", "Residents", "Kind", "Description", "Amount"],
                        rows.map((r) => [r.due as string, r.property as string, r.unit as string, r.residents as string, r.kind as string, r.description as string, csvMoney(r.amount as number)])),
                }
            }
            case "expenses": {
                const rows = await this.db.expenseRows(from, to)
                return {
                    filename: `expenses-${range}.csv`,
                    csv: toCsv(["Date", "Property", "Unit", "Category", "Vendor", "Description", "Amount"],
                        rows.map((r) => [r.date as string, (r.property as string) ?? "All properties", r.unit as string, r.category as string, r.vendor as string, r.description as string, csvMoney(r.amount as number)])),
                }
            }
            case "maintenance": {
                const rows = await this.db.maintenanceRows(from, to, this.timeZone)
                return {
                    filename: `maintenance-${range}.csv`,
                    csv: toCsv(["Request", "Opened", "Property", "Unit", "Title", "Type", "Priority", "Stage", "Completed", "Assigned to", "Labor", "Materials", "Total cost"],
                        rows.map((r) => {
                            const labor = r.labor as number | null, materials = r.materials as number | null
                            return [r.id as number, r.opened as string, r.property as string, r.unit as string, r.title as string, r.type as string, r.priority as string,
                                String(r.status).replace(/_/g, " "), r.completed as string, r.assigned as string, csvMoney(labor), csvMoney(materials),
                                labor === null && materials === null ? "" : csvMoney((labor ?? 0) + (materials ?? 0))]
                        })),
                }
            }
            case "income-by-property": {
                const year = params.year ?? Number(today.slice(0, 4))
                const rows = await this.db.incomeByPropertyRows(year, this.timeZone)
                return {
                    filename: `income-by-property-${year}.csv`,
                    csv: toCsv(["Property", "Collected", "Expenses", "Net"], rows.map((r) => [r.property, csvMoney(r.collected), csvMoney(r.expenses), csvMoney(r.collected - r.expenses)])),
                }
            }
            case "portfolios": {
                const { portfolios, unassigned } = await this.portfolios()
                return {
                    filename: `portfolios-${today}.csv`,
                    csv: toCsv(["Portfolio", "Legal entity", "Properties", "Units", "Occupied", "Occupancy", "Monthly rent", "Outstanding"], [
                        ...portfolios.map((f) => [f.name, f.entityName, f.properties.map((p) => p.name).join("; "), f.units, f.occupied,
                            f.units ? `${Math.round(f.occupancy * 100)}%` : "", csvMoney(f.monthlyRent), csvMoney(f.outstanding)]),
                        ...(unassigned.length ? [["Not in a portfolio", "", unassigned.map((p) => p.name).join("; "), "", "", "", "", ""]] : []),
                    ]),
                }
            }
            default:
                throw new AppError("NOT_FOUND")
        }
    }

    /* ---- Search ---- */

    async search(query: string, role: StaffRole): Promise<SearchHit[]> {
        const q = query.trim().replace(/\s+/g, " ")
        if (q.length < SEARCH_MIN_LENGTH) return []
        return this.db.search(q.slice(0, 100), q.replace(/\D/g, ""), role === "maintenance_staff")
    }
}

/** An Admin update whose only change is last_login_at (written by every staff sign-in). */
function onlyStampsLastLogin(c: { table: string; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }): boolean {
    if (c.table !== "admin" || c.action !== "UPDATE" || !c.before || !c.after) return false
    const changed = Object.keys(c.after).filter((k) => JSON.stringify(c.before![k]) !== JSON.stringify(c.after![k]))
    return changed.length === 1 && changed[0] === "last_login_at"
}

const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" })

function isTimeZone(zone: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone })
        return true
    } catch {
        return false
    }
}
