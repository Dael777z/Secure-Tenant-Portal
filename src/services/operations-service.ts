import { runAs, SYSTEM, currentIdentity } from "../db/identity"
import { silentLogger, type LogMetadata, type LogService } from "../logging"
import { AppError } from "../types/errors"
import type { ManualChargeKind } from "../types/inputs"
import type {
    ChargesView, ChargeViewRow, DocumentRow, FeeType, LateFeeRuleRow, LeaseDocumentFile, NewLateFeeRule, NewReminderRule,
    OfficeNotifications, ReminderRuleRow, ReminderSentRow, RuleScope, ScopeLabel, StaffMember, UnitDetail, UnitLeaseRow, UnitRuleRow,
} from "../types/operations"
import type { LeaseRecord, PaymentRecord, PropertyRecord, UnitRecord } from "../types/records"
import type { OperationsDataStore } from "../types/stores"
import { OFFICE_PAYMENT_PREFIX } from "../utils/confirmations"
import { CHARGE_KIND_LABELS, LATE_AFTER_DAYS, addDays, allocate, cents, dollars, localDay } from "./finance"
import { formatDate, localDate } from "./ledger"

/**
 * RentRedi-style management (008): Rent & Charges, the unit page, lease PDFs,
 * late fee rules, rent reminders, the team and office notifications. Staff only
 * (the routes check), and row-level security says the same in the database.
 *
 * The nightly jobs (late fees, reminders) run in SQL (apply_late_fees,
 * send_rent_reminders), after the rent job adds the month's rent.
 */

/** A repeating charge is at most two years of months. */
export const MAX_OCCURRENCES = 24
/** A signed lease PDF is at most 4 MB (the request body limit fits it as base64). */
export const LEASE_PDF_MAX_BYTES = 4 * 1024 * 1024

const isOffice = (p: PaymentRecord) => p.confirmation.startsWith(OFFICE_PAYMENT_PREFIX)

/** "YYYY-MM-DD" n months later, on the same day (the month's last day when it is shorter). */
export function addMonths(date: string, n: number): string {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number]
    const lastDay = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate()
    return new Date(Date.UTC(y, m - 1 + n, Math.min(d, lastDay))).toISOString().slice(0, 10)
}

/** A fee in dollars: flat, or a percent of the rent charge. */
export function feeFor(amount: number, type: FeeType, rent: number): number {
    return type === "percent" ? Math.round(rent * amount) / 100 : amount
}

/**
 * The late fee schedule a rule gives a rent charge, day by day while it stays
 * unpaid: the first fee on the grace day, the daily fee every day after, never
 * more than the cap in total (the same rule apply_late_fees() uses in 008).
 */
export function lateFeeSchedule(rule: Pick<LateFeeRuleRow, "graceDays" | "firstAmount" | "firstType" | "dailyAmount" | "dailyType" | "maxAmount" | "maxType">, rent: number, days: number) {
    const cap = rule.maxAmount === null ? null : cents(feeFor(rule.maxAmount, rule.maxType, rent))
    let total = 0
    const out: Array<{ daysLate: number; fee: number; total: number }> = []
    for (let k = 0; k <= days; k++) {
        let fee = 0
        if (k === rule.graceDays) fee = cents(feeFor(rule.firstAmount, rule.firstType, rent))
        else if (k > rule.graceDays) fee = cents(feeFor(rule.dailyAmount, rule.dailyType, rent))
        if (cap !== null) fee = Math.max(0, Math.min(fee, cap - total))
        total += fee
        out.push({ daysLate: k, fee: dollars(fee), total: dollars(total) })
    }
    return out
}

export class OperationsService {
    constructor(
        private readonly db: OperationsDataStore,
        private readonly timeZone: string,
        private readonly log: LogService = silentLogger,
    ) {}

    private today(): string {
        return localDate(new Date(), this.timeZone)
    }

    /** Every change is logged with who made it. */
    private change<T>(event: string, metadata: LogMetadata, work: () => Promise<T>, outcome?: (result: T) => LogMetadata): Promise<T> {
        const who = currentIdentity()
        const by = "id" in who ? `${who.type}:${who.id}` : who.type
        return this.log.flow(event, { by, ...metadata }, work, outcome)
    }

    // ---- The nightly jobs

    /** Late fees, then reminders, for today (as the system). Safe to repeat. */
    // logs operations.daily.succeeded { lateFees, reminders }
    async runDailyJobs(): Promise<{ lateFees: number; reminders: number }> {
        const today = this.today()
        return this.log.flow("operations.daily", { today }, () => runAs(SYSTEM, async () => {
            const lateFees = await this.db.applyLateFees(today, this.timeZone)
            const reminders = await this.db.sendRentReminders(today, this.timeZone)
            return { lateFees, reminders }
        }), (r) => r)
    }

    // ---- Rule scopes

    private async scopes() {
        const [properties, units] = await Promise.all([this.db.listProperties(), this.db.listUnits()])
        return { properties, units }   // listUnits skips retired units
    }

    private scopeLabel(scope: RuleScope, properties: PropertyRecord[], units: UnitRecord[]): ScopeLabel {
        if (scope.unitId !== null) {
            const u = units.find((x) => x.id === scope.unitId)
            return { ...scope, label: u ? `Unit ${u.unitNum} - ${u.propertyName}` : "A unit" }
        }
        if (scope.propertyId !== null) return { ...scope, label: properties.find((p) => p.id === scope.propertyId)?.name ?? "A property" }
        return { ...scope, label: "All properties" }
    }

    private async requireScope(scope: RuleScope): Promise<void> {
        const { properties, units } = await this.scopes()
        if (scope.unitId !== null) {
            const u = units.find((x) => x.id === scope.unitId)
            if (!u || u.propertyId !== scope.propertyId) throw new AppError("VALIDATION_ERROR")
        } else if (scope.propertyId !== null && !properties.some((p) => p.id === scope.propertyId)) {
            throw new AppError("VALIDATION_ERROR")
        }
    }

    /** Which rule (unit, then property, then all) covers every unit. */
    private unitRules<R extends RuleScope & { id: number }>(rules: R[], units: UnitRecord[]): UnitRuleRow[] {
        return units.map((u) => {
            const own = rules.find((r) => r.unitId === u.id)
            const prop = rules.find((r) => r.unitId === null && r.propertyId === u.propertyId)
            const all = rules.find((r) => r.unitId === null && r.propertyId === null)
            const rule = own ?? prop ?? all ?? null
            return {
                unitId: u.id, unitNum: u.unitNum, propertyId: u.propertyId, propertyName: u.propertyName,
                ruleId: rule?.id ?? null, source: own ? "unit" : prop ? "property" : all ? "all" : null,
            }
        })
    }

    // ---- Late fee rules

    async lateFeeRules(): Promise<{ rules: LateFeeRuleRow[]; units: UnitRuleRow[] }> {
        const [{ properties, units }, rules] = await Promise.all([this.scopes(), this.db.listLateFeeRules()])
        return {
            rules: rules.map((r) => ({ ...r, ...this.scopeLabel(r, properties, units), createdAt: r.createdAt.toISOString() })),
            units: this.unitRules(rules, units),
        }
    }

    // logs office.late_fee_rule.save.succeeded { ruleId, propertyId, unitId }
    async saveLateFeeRule(input: NewLateFeeRule): Promise<number> {
        await this.requireScope(input)
        if (input.firstAmount <= 0 && input.dailyAmount <= 0) throw new AppError("VALIDATION_ERROR")
        if ((input.firstType === "percent" && input.firstAmount > 100) || (input.dailyType === "percent" && input.dailyAmount > 100) || (input.maxType === "percent" && (input.maxAmount ?? 0) > 100)) {
            throw new AppError("VALIDATION_ERROR")
        }
        return this.change("office.late_fee_rule.save", { propertyId: input.propertyId, unitId: input.unitId }, () => this.db.saveLateFeeRule(input), (ruleId) => ({ ruleId }))
    }

    retireLateFeeRule(ruleId: number): Promise<void> {
        return this.change("office.late_fee_rule.retire", { ruleId }, () => this.db.retireLateFeeRule(ruleId))
    }

    // ---- Rent reminders

    async reminderRules(): Promise<{ rules: ReminderRuleRow[]; units: UnitRuleRow[]; sent: ReminderSentRow[] }> {
        const [{ properties, units }, rules, sent, locations, residents] = await Promise.all([
            this.scopes(), this.db.listReminderRules(), this.db.listRemindersSent({ limit: 100 }), this.db.listLeaseLocations(), this.db.listLeaseResidents(),
        ])
        const where = new Map(locations.map((l) => [l.leaseId, l]))
        return {
            rules: rules.map((r) => ({ ...r, ...this.scopeLabel(r, properties, units), createdAt: r.createdAt.toISOString() })),
            units: this.unitRules(rules, units),
            sent: sent.map((s) => ({
                chargeId: s.chargeId, leaseId: s.leaseId, sentOn: s.sentOn, kind: s.kind, amount: s.amount, dueDate: s.dueDate,
                unitLabel: where.get(s.leaseId) ? `Unit ${where.get(s.leaseId)!.unitNum} - ${where.get(s.leaseId)!.propertyName}` : "Unit",
                tenants: residents.filter((r) => r.leaseId === s.leaseId).map((r) => r.name),
            })),
        }
    }

    async saveReminderRule(input: NewReminderRule): Promise<number> {
        await this.requireScope(input)
        return this.change("office.reminder_rule.save", { propertyId: input.propertyId, unitId: input.unitId }, () => this.db.saveReminderRule(input), (ruleId) => ({ ruleId }))
    }

    retireReminderRule(ruleId: number): Promise<void> {
        return this.change("office.reminder_rule.retire", { ruleId }, () => this.db.retireReminderRule(ruleId))
    }

    // ---- Charges: one or a repeating charge

    // logs office.charge.add.succeeded { leaseId, kind, amount, occurrences }
    addCharges(leaseId: number, input: { kind: ManualChargeKind; amount: number; dueDate: string; description: string | null; occurrences: number }): Promise<number[]> {
        if (!Number.isInteger(input.occurrences) || input.occurrences < 1 || input.occurrences > MAX_OCCURRENCES) return Promise.reject(new AppError("VALIDATION_ERROR"))
        const rows = Array.from({ length: input.occurrences }, (_, n) => ({
            leaseId, kind: input.kind, amount: input.amount, dueDate: addMonths(input.dueDate, n), description: input.description,
        }))
        return this.change("office.charge.add", { leaseId, kind: input.kind, amount: input.amount, occurrences: input.occurrences },
            () => this.db.addCharges(rows), (ids) => ({ chargeIds: ids }))
    }

    // ---- Rent & Charges

    /** Defaults: this month (the property's calendar). */
    async charges(fromIn: string | null, toIn: string | null): Promise<ChargesView> {
        const today = this.today()
        const from = fromIn ?? `${today.slice(0, 7)}-01`
        const to = toIn ?? new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)), 0)).toISOString().slice(0, 10)
        if (to < from) throw new AppError("VALIDATION_ERROR")
        const [charges, payments, locations, residents] = await Promise.all([
            this.db.listAllCharges(), this.db.listAllPayments(), this.db.listLeaseLocations(), this.db.listLeaseResidents(),
        ])
        const where = new Map(locations.map((l) => [l.leaseId, l]))
        const paymentById = new Map(payments.map((p) => [p.id, p]))
        const byLease = new Map<number, typeof charges>()
        for (const c of charges) byLease.set(c.leaseId, [...(byLease.get(c.leaseId) ?? []), c])

        const rows: ChargeViewRow[] = []
        let allTimeLate = 0
        for (const [leaseId, list] of byLease) {
            const alloc = allocate(list, payments.filter((p) => p.leaseId === leaseId))
            const w = where.get(leaseId)
            for (const a of alloc.charges) {
                const c = a.charge
                const unpaid = cents(c.amount) - a.appliedCents
                const late = unpaid > 0 && addDays(c.dueDate, LATE_AFTER_DAYS) < today
                if (late) allTimeLate += unpaid
                if (c.dueDate < from || c.dueDate > to) continue
                const sources = new Set(a.applications.map((x) => (paymentById.get(x.paymentId) && isOffice(paymentById.get(x.paymentId)!) ? "manual" : "online")))
                rows.push({
                    id: c.id, leaseId, unitId: w?.unitId ?? 0, unitNum: w?.unitNum ?? "", propertyId: w?.propertyId ?? 0, propertyName: w?.propertyName ?? "",
                    tenants: residents.filter((r) => r.leaseId === leaseId).map((r) => ({ id: r.tenantId, name: r.name })),
                    kind: c.kind, kindLabel: CHARGE_KIND_LABELS[c.kind] ?? c.kind,
                    description: c.description ?? CHARGE_KIND_LABELS[c.kind] ?? "Charge",
                    dueDate: c.dueDate, amount: c.amount, paid: dollars(a.appliedCents), unpaid: dollars(Math.max(0, unpaid)),
                    status: unpaid <= 0 ? "paid" : late ? "late" : "due",
                    source: sources.size === 0 ? null : sources.size > 1 ? "both" : ([...sources][0] as "manual" | "online"),
                    paidOn: a.paidInFullAt ? localDay(a.paidInFullAt, this.timeZone) : null,
                })
            }
        }
        rows.sort((x, y) => x.dueDate.localeCompare(y.dueDate) || x.propertyName.localeCompare(y.propertyName) || x.unitNum.localeCompare(y.unitNum, undefined, { numeric: true }) || x.id - y.id)
        const sum = (pick: (r: ChargeViewRow) => number) => dollars(rows.reduce((s, r) => s + cents(pick(r)), 0))
        return {
            from, to,
            summary: {
                charged: sum((r) => r.amount),
                paid: sum((r) => r.paid),
                due: sum((r) => (r.status === "due" ? r.unpaid : 0)),
                late: sum((r) => (r.status === "late" ? r.unpaid : 0)),
            },
            allTimeLate: dollars(allTimeLate),
            rows,
        }
    }

    // ---- The unit page

    async unit(unitId: number): Promise<UnitDetail> {
        const today = this.today()
        const [units, properties, leases, residents, balances, charges, payments, docs, requests] = await Promise.all([
            this.db.listUnits(), this.db.listProperties(), this.db.listLeases(), this.db.listLeaseResidents(), this.db.listLeaseBalances(),
            this.db.listAllCharges(), this.db.listAllPayments(), this.db.listLeaseDocuments(), this.db.listMaintenance(),
        ])
        const u = units.find((x) => x.id === unitId)
        if (!u) throw new AppError("NOT_FOUND")
        const property = properties.find((p) => p.id === u.propertyId)
        const mine = leases.filter((l) => l.unitId === unitId).sort((a, b) => b.startDate.localeCompare(a.startDate))
        const stateOf = (l: LeaseRecord): UnitLeaseRow["state"] => (l.startDate > today ? "upcoming" : l.endDate && l.endDate < today ? "ended" : "current")
        const rows: UnitLeaseRow[] = mine.map((l) => {
            const doc = docs.find((d) => d.leaseId === l.id)
            return {
                id: l.id, startDate: l.startDate, endDate: l.endDate, monthlyRent: l.monthlyRent,
                tenants: residents.filter((r) => r.leaseId === l.id).map((r) => ({ id: r.tenantId, name: r.name })),
                balance: balances.find((b) => b.leaseId === l.id)?.balance ?? 0,
                state: stateOf(l),
                document: doc ? { filename: doc.filename, uploadedAt: doc.uploadedAt.toISOString() } : null,
            }
        })
        const current = rows.find((r) => r.state === "current") ?? rows.find((r) => r.state === "upcoming") ?? null

        // Last 12 months on this unit.
        const since = addDays(today, -365)
        let billed = 0, collected = 0, rentCount = 0, onTime = 0
        for (const l of mine) {
            const alloc = allocate(charges.filter((c) => c.leaseId === l.id), payments.filter((p) => p.leaseId === l.id))
            for (const a of alloc.charges) {
                if (a.charge.dueDate < since || a.charge.dueDate > today) continue
                billed += cents(a.charge.amount)
                collected += a.appliedCents
                if (a.charge.kind === "rent") {
                    rentCount++
                    if (a.paidInFullAt && localDay(a.paidInFullAt, this.timeZone) <= addDays(a.charge.dueDate, LATE_AFTER_DAYS)) onTime++
                }
            }
        }
        const monthsLeased = mine.reduce((n, l) => {
            const start = l.startDate > since ? l.startDate : since
            const end = l.endDate && l.endDate < today ? l.endDate : today
            return end > start ? n + Math.round((Date.parse(end) - Date.parse(start)) / (30.44 * 86_400_000)) : n
        }, 0)
        const open = requests.filter((m) => m.unitId === unitId && m.status !== "resolved")
        return {
            id: u.id, unitNum: u.unitNum, propertyId: u.propertyId, propertyName: u.propertyName, address: property?.address ?? "",
            leaseId: current?.id ?? null,
            leases: rows,
            performance: {
                billed: dollars(billed), collected: dollars(collected),
                collectionRate: billed ? collected / billed : null,
                onTimeRate: rentCount ? onTime / rentCount : null,
                monthsLeased: Math.min(12, monthsLeased),
                openRequests: open.length,
            },
            maintenance: requests.filter((m) => m.unitId === unitId).slice(0, 20).map((m) => ({
                id: m.id, title: m.title, status: m.status, priority: m.priority, submittedDate: formatDate(m.createdAt, this.timeZone),
            })),
        }
    }

    // ---- Documents

    async documents(): Promise<DocumentRow[]> {
        const [docs, receipts, locations, residents] = await Promise.all([
            this.db.listLeaseDocuments(), this.db.listReceiptsMeta(), this.db.listLeaseLocations(), this.db.listLeaseResidents(),
        ])
        const where = new Map(locations.map((l) => [l.leaseId, l]))
        const label = (leaseId: number) => (where.get(leaseId) ? `Unit ${where.get(leaseId)!.unitNum} - ${where.get(leaseId)!.propertyName}` : "Unit")
        const names = (leaseId: number) => residents.filter((r) => r.leaseId === leaseId).map((r) => r.name)
        return [
            ...docs.map((d): DocumentRow => ({
                kind: "lease", leaseId: d.leaseId, unitLabel: label(d.leaseId), tenants: names(d.leaseId), filename: d.filename,
                sizeBytes: d.sizeBytes, uploadedAt: d.uploadedAt.toISOString(), uploadedBy: d.uploadedBy, paymentId: null,
            })),
            ...receipts.map((r): DocumentRow => ({
                kind: "receipt", leaseId: r.leaseId, unitLabel: label(r.leaseId), tenants: names(r.leaseId), filename: r.filename,
                sizeBytes: r.sizeBytes, uploadedAt: r.uploadedAt.toISOString(), uploadedBy: null, paymentId: r.paymentId,
            })),
        ].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
    }

    /** A PDF sent as base64 (checked: really a PDF, at most 4 MB). */
    // logs office.lease_document.upload.succeeded { leaseId, bytes }
    async uploadLeaseDocument(leaseId: number, file: { filename: string; data: string }): Promise<void> {
        const bytes = Buffer.from(file.data, "base64")
        if (!bytes.length || bytes.length > LEASE_PDF_MAX_BYTES || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new AppError("RECEIPT_INVALID")
        const name = file.filename.replace(/[^\w .()-]/g, "_").slice(0, 200) || "lease.pdf"
        await this.change("office.lease_document.upload", { leaseId, bytes: bytes.length }, () => this.db.saveLeaseDocument(leaseId, { filename: name, data: bytes }))
    }

    leaseDocument(leaseId: number): Promise<LeaseDocumentFile | null> {
        return this.db.findLeaseDocument(leaseId)
    }

    // ---- The team and office notifications

    staff(): Promise<StaffMember[]> {
        return this.db.listStaff()
    }

    notifications(): Promise<OfficeNotifications> {
        return this.db.getOfficeNotifications()
    }

    // logs office.notifications.update.succeeded
    saveNotifications(input: OfficeNotifications): Promise<void> {
        return this.change("office.notifications.update", { ...input, notifyEmail: input.notifyEmail ? "set" : null }, () => this.db.saveOfficeNotifications(input))
    }
}
