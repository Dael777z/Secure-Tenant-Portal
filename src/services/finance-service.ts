import type { LogService } from "../logging"
import { silentLogger } from "../logging"
import { AppError } from "../types/errors"
import type {
    Analytics, CollectionRow, ExpenseLine, ExpiringLeaseRow, FinanceOverview, FinancePeriod, IncomeLine,
    MonthTrend, NewExpense, PropertyPerformance, RecentPaymentRow, ResidentContact,
} from "../types/finance"
import { EXPENSE_CATEGORIES } from "../types/finance"
import type { ChargeRecord, LeaseRecord, PaymentRecord } from "../types/records"
import type { FinanceDataStore } from "../types/stores"
import { MANUAL_PAY_LABELS, type OfficeSettings, type ReportedPaymentRecord, type ReportedPaymentRow } from "../types/settings"
import { parseUserId } from "../utils/user-id"
import {
    CHARGE_KIND_LABELS, EXPENSE_LABELS, LATE_AFTER_DAYS, addDays, aging, allocate, cents, daysBetween, dollars, inRange,
    lastMonths, localDay, monthEnd, monthKey, monthLabel, monthlyRows, periodOf, ratio, round2, sumAging, type LeaseAllocation,
} from "./finance"
import { formatDate, localDate } from "./ledger"

const isActiveOn = (lease: LeaseRecord, day: string) => lease.startDate <= day && (lease.endDate === null || lease.endDate >= day)

/** Everything the finance screens read, fetched once per request. */
interface Book {
    today: string
    leases: Map<number, LeaseRecord>
    where: Map<number, { unitId: number; unitNum: string; propertyId: number; propertyName: string }>
    residents: Map<number, ResidentContact[]>
    charges: ChargeRecord[]
    payments: PaymentRecord[]
    alloc: Map<number, LeaseAllocation>
    balance: Map<number, number>
    lastContact: Map<number, Date>
}

/**
 * The office's money screens: collections, recent payments, monthly income
 * vs. expenses, profit & loss, and portfolio performance. Read-only except for
 * expenses and renewal notices. Staff ('admin') only, by route permission and
 * by RLS on every table it reads.
 */
export class FinanceService {
    constructor(
        private readonly db: FinanceDataStore,
        private readonly timeZone: string,
        private readonly log: LogService = silentLogger,
    ) {}

    private today(): string {
        return localDate(new Date(), this.timeZone)
    }

    private async book(): Promise<Book> {
        const [leases, locations, residents, people, charges, payments, balances, lastOffice] = await Promise.all([
            this.db.listLeases(), this.db.listLeaseLocations(), this.db.listLeaseResidents(), this.db.listPeople(),
            this.db.listAllCharges(), this.db.listAllPayments(), this.db.listLeaseBalances(), this.db.listLastOfficeMessages(),
        ])
        const person = new Map(people.map((p) => [p.id, p]))
        const byLease = new Map<number, ResidentContact[]>()
        for (const r of residents) {
            const p = person.get(r.tenantId)
            const contact = { id: r.tenantId, name: r.name, email: p?.email ?? "", phone: p?.phone ?? null }
            byLease.set(r.leaseId, [...(byLease.get(r.leaseId) ?? []), contact])
        }
        const alloc = new Map<number, LeaseAllocation>()
        for (const lease of leases) {
            alloc.set(lease.id, allocate(charges.filter((c) => c.leaseId === lease.id), payments.filter((p) => p.leaseId === lease.id)))
        }
        return {
            today: this.today(),
            leases: new Map(leases.map((l) => [l.id, l])),
            where: new Map(locations.map((l) => [l.leaseId, l])),
            residents: byLease,
            charges,
            payments,
            alloc,
            balance: new Map(balances.map((b) => [b.leaseId, b.balance])),
            lastContact: new Map(lastOffice.map((m) => [m.tenantId, m.at])),
        }
    }

    private unitLabel(book: Book, leaseId: number): string {
        const w = book.where.get(leaseId)
        return w ? `Unit ${w.unitNum}` : "Unit"
    }

    private cashIn(book: Book, from: string, to: string, leaseIds?: Set<number>): { cash: number; refunds: number } {
        let cash = 0
        let refunds = 0
        for (const p of book.payments) {
            if (p.status !== "completed" || (leaseIds && !leaseIds.has(p.leaseId))) continue
            if (!inRange(localDay(p.paidAt, this.timeZone), from, to)) continue
            if (p.direction === "refund") { cash -= cents(p.amount); refunds += cents(p.amount) } else cash += cents(p.amount)
        }
        return { cash, refunds }
    }

    // ---- Finance tab

    async overview(periodKey: FinancePeriod): Promise<FinanceOverview> {
        const [book, expenses] = await Promise.all([this.book(), this.db.listExpenses()])
        const { today } = book
        const period = periodOf(periodKey, today)

        // Charges due in the period: paid, open (not late yet), late.
        let due = 0, paid = 0, open = 0, late = 0
        for (const a of book.alloc.values()) {
            for (const c of a.charges) {
                if (!inRange(c.charge.dueDate, period.from, period.to)) continue
                due += cents(c.charge.amount)
                paid += c.appliedCents
                const unpaid = cents(c.charge.amount) - c.appliedCents
                if (unpaid > 0) {
                    if (daysBetween(c.charge.dueDate, today) > LATE_AFTER_DAYS) late += unpaid
                    else open += unpaid
                }
            }
        }
        const { cash, refunds } = this.cashIn(book, period.from, period.to)
        const periodExpenses = expenses.filter((e) => inRange(e.spentOn, period.from, period.to))
        const spent = periodExpenses.reduce((sum, e) => sum + cents(e.amount), 0)

        // Collections: every lease with something unpaid, worst first.
        const collections: CollectionRow[] = []
        for (const [leaseId, a] of book.alloc) {
            const lease = book.leases.get(leaseId)!
            const w = book.where.get(leaseId)
            const age = aging(a.charges, today)
            if (age.total <= 0) continue
            const tenants = book.residents.get(leaseId) ?? []
            const lastPaid = [...a.payments].reverse().find((p) => p.payment.direction === "charge")
            const contacts = tenants.map((t) => book.lastContact.get(t.id)).filter((d): d is Date => Boolean(d))
            const lateAmount = age.total - age.current
            collections.push({
                ...age,
                leaseId,
                unitLabel: this.unitLabel(book, leaseId),
                propertyId: w?.propertyId ?? 0,
                propertyName: w?.propertyName ?? "",
                tenants,
                monthlyRent: lease.monthlyRent,
                balance: book.balance.get(leaseId) ?? age.total - dollars(a.creditCents),
                credit: dollars(a.creditCents),
                monthsBehind: lease.monthlyRent > 0 ? Math.round((lateAmount / lease.monthlyRent) * 10) / 10 : 0,
                lastPayment: lastPaid ? { amount: lastPaid.payment.amount, paidAt: lastPaid.payment.paidAt.toISOString() } : null,
                lateFeesBilled: dollars(a.charges.filter((c) => c.charge.kind === "late_fee").reduce((sum, c) => sum + cents(c.charge.amount), 0)),
                lastContactAt: contacts.length ? new Date(Math.max(...contacts.map((d) => d.getTime()))).toISOString() : null,
                ended: lease.endDate !== null && lease.endDate < today,
            })
        }
        collections.sort((x, y) => (y.total - y.current) - (x.total - x.current) || y.daysLate - x.daysLate)

        // Recent payments in the period, newest first, with what each one paid for.
        const chargeById = new Map<number, ReturnType<typeof allocate>["charges"][number]>()
        for (const a of book.alloc.values()) for (const c of a.charges) chargeById.set(c.charge.id, c)
        const recent: RecentPaymentRow[] = []
        for (const a of book.alloc.values()) {
            for (const item of a.payments) {
                const p = item.payment
                if (!inRange(localDay(p.paidAt, this.timeZone), period.from, period.to)) continue
                const first = item.applied[0] ? chargeById.get(item.applied[0].chargeId) : undefined
                const touched = item.applied.map((x) => chargeById.get(x.chargeId)!).filter(Boolean)
                const partial = touched.some((c) => c.paidInFullAt === null || c.paidInFullAt.getTime() > p.paidAt.getTime())
                const payer = p.payerId !== null ? book.residents.get(p.leaseId)?.find((t) => t.id === p.payerId)?.name : undefined
                recent.push({
                    id: p.id,
                    leaseId: p.leaseId,
                    payer: payer ?? (p.direction === "refund" ? "Reversal" : "Manual entry"),
                    unitLabel: this.unitLabel(book, p.leaseId),
                    propertyName: book.where.get(p.leaseId)?.propertyName ?? "",
                    amount: p.amount,
                    paidAt: p.paidAt.toISOString(),
                    method: p.method,
                    confirmation: p.confirmation,
                    status: p.direction === "refund" ? "refund" : touched.length === 0 ? "prepaid" : partial ? "partial" : "paid",
                    forCharge: first ? { kind: CHARGE_KIND_LABELS[first.charge.kind] ?? first.charge.kind, dueDate: first.charge.dueDate } : null,
                })
            }
        }
        recent.sort((x, y) => y.paidAt.localeCompare(x.paidAt) || y.id - x.id)

        // Profit & loss for the period (cash basis, with what was billed beside it).
        const income = new Map<string, { billed: number; collected: number }>()
        const line = (kind: string) => income.get(kind) ?? income.set(kind, { billed: 0, collected: 0 }).get(kind)!
        let prepaid = 0
        for (const a of book.alloc.values()) {
            for (const c of a.charges) {
                if (inRange(c.charge.dueDate, period.from, period.to)) line(c.charge.kind).billed += cents(c.charge.amount)
                for (const app of c.applications) {
                    if (inRange(localDay(app.at, this.timeZone), period.from, period.to)) line(c.charge.kind).collected += app.cents
                }
            }
            for (const item of a.payments) {
                if (item.payment.direction === "charge" && inRange(localDay(item.payment.paidAt, this.timeZone), period.from, period.to)) prepaid += item.unappliedCents
            }
        }
        const order = Object.keys(CHARGE_KIND_LABELS)
        const incomeLines: IncomeLine[] = [...income.entries()]
            .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
            .map(([category, v]) => ({ category, label: CHARGE_KIND_LABELS[category] ?? category, billed: dollars(v.billed), collected: dollars(v.collected) }))
        const categorized = [...income.values()].reduce((sum, v) => sum + v.collected, 0) + prepaid
        // Refunds and reversals, including any that undo a payment from before this period.
        const adjustment = cash - categorized
        const byCategory = new Map<string, number>()
        for (const e of periodExpenses) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + cents(e.amount))
        const expenseLines: ExpenseLine[] = EXPENSE_CATEGORIES.filter((c) => byCategory.has(c)).map((category) => ({ category, label: EXPENSE_LABELS[category], amount: dollars(byCategory.get(category)!) }))

        const properties = await this.db.listProperties()
        const byProperty = properties.map((prop) => {
            const leaseIds = new Set([...book.where.entries()].filter(([, w]) => w.propertyId === prop.id).map(([id]) => id))
            const billed = book.charges.filter((c) => leaseIds.has(c.leaseId) && inRange(c.dueDate, period.from, period.to)).reduce((s, c) => s + cents(c.amount), 0)
            const collected = this.cashIn(book, period.from, period.to, leaseIds).cash
            const exp = periodExpenses.filter((e) => e.propertyId === prop.id).reduce((s, e) => s + cents(e.amount), 0)
            return { propertyId: prop.id as number | null, name: prop.name, billed: dollars(billed), collected: dollars(collected), expenses: dollars(exp), net: dollars(collected - exp) }
        })
        const portfolioWide = periodExpenses.filter((e) => e.propertyId === null).reduce((s, e) => s + cents(e.amount), 0)
        if (portfolioWide > 0) byProperty.push({ propertyId: null, name: "Portfolio-wide", billed: 0, collected: 0, expenses: dollars(portfolioWide), net: -dollars(portfolioWide) })

        const totalBilled = [...income.values()].reduce((sum, v) => sum + v.billed, 0)
        return {
            asOf: today,
            lateAfterDays: LATE_AFTER_DAYS,
            period,
            summary: {
                chargesDue: dollars(due), paid: dollars(paid), open: dollars(open), late: dollars(late),
                collectedRate: ratio(paid, due), cashCollected: dollars(cash), refunds: dollars(refunds),
                expenses: dollars(spent), net: dollars(cash - spent),
            },
            aging: { ...sumAging(collections), accounts: collections.length },
            collections,
            recentPayments: recent.slice(0, 60),
            monthly: monthlyRows({ months: lastMonths(today, 12), charges: book.charges, payments: book.payments, expenses, timeZone: this.timeZone }),
            pnl: {
                income: incomeLines,
                prepaid: dollars(prepaid),
                refunds: dollars(adjustment),
                totalBilled: dollars(totalBilled),
                totalCollected: dollars(cash),
                expenses: expenseLines,
                totalExpenses: dollars(spent),
                netOperatingIncome: dollars(cash - spent),
                margin: cash > 0 ? round2((cash - spent) / cash) : 0,
                byProperty,
            },
            expenses: periodExpenses,
        }
    }

    // ---- Performance tab

    async analytics(): Promise<Analytics> {
        const [book, expenses, units, properties, timings] = await Promise.all([
            this.book(), this.db.listExpenses(), this.db.listUnits(), this.db.listProperties(), this.db.listMaintenanceTimings(),
        ])
        const { today } = book
        const months = lastMonths(today, 12)
        const from = `${months[0]}-01`
        const activeUnitIds = new Set(units.map((u) => u.id))
        const leases = [...book.leases.values()]
        const activeNow = leases.filter((l) => isActiveOn(l, today) && activeUnitIds.has(l.unitId))
        const soon = addDays(today, 90)
        const expiring = activeNow.filter((l) => l.endDate !== null && l.endDate >= today && l.endDate <= soon)

        // Per charge, in the 12-month window: billed, paid, on time, days to pay.
        const stats = (leaseIds?: Set<number>) => {
            let billed = 0, applied = 0, onTimeDue = 0, onTime = 0, paidRent = 0, paidDays = 0
            for (const [leaseId, a] of book.alloc) {
                if (leaseIds && !leaseIds.has(leaseId)) continue
                for (const c of a.charges) {
                    if (!inRange(c.charge.dueDate, from, today)) continue
                    billed += cents(c.charge.amount)
                    applied += c.appliedCents
                    if (c.charge.kind !== "rent") continue
                    const graceEnd = addDays(c.charge.dueDate, LATE_AFTER_DAYS)
                    if (graceEnd < today) {
                        onTimeDue++
                        if (c.paidInFullAt && localDay(c.paidInFullAt, this.timeZone) <= graceEnd) onTime++
                    }
                    if (c.paidInFullAt) {
                        paidRent++
                        paidDays += Math.max(0, daysBetween(c.charge.dueDate, localDay(c.paidInFullAt, this.timeZone)))
                    }
                }
            }
            return { billed, applied, onTimeDue, onTime, paidRent, paidDays }
        }
        const all = stats()
        const cash12 = this.cashIn(book, from, today).cash
        const spent12 = expenses.filter((e) => inRange(e.spentOn, from, today)).reduce((s, e) => s + cents(e.amount), 0)
        const rentRoll = activeNow.reduce((s, l) => s + cents(l.monthlyRent), 0)
        const outstanding = leases.reduce((s, l) => s + Math.max(0, cents(book.balance.get(l.id) ?? 0)), 0)
        const resolved12 = timings.filter((t) => t.resolvedAt && localDay(t.resolvedAt, this.timeZone) >= from)
        const avgResolution = resolved12.length
            ? Math.round((resolved12.reduce((s, t) => s + (t.resolvedAt!.getTime() - t.createdAt.getTime()), 0) / resolved12.length / 86_400_000) * 10) / 10
            : null
        const openTimings = timings.filter((t) => t.status !== "resolved")
        const oldestOpen = openTimings.length ? Math.max(...openTimings.map((t) => daysBetween(localDay(t.createdAt, this.timeZone), today))) : null

        // Month by month.
        const monthRows = monthlyRows({ months, charges: book.charges, payments: book.payments, expenses, timeZone: this.timeZone })
        const trend: MonthTrend[] = monthRows.map((m) => {
            const end = m.month === monthKey(today) ? today : monthEnd(m.month)
            let billed = 0, applied = 0
            for (const a of book.alloc.values()) {
                for (const c of a.charges) {
                    if (monthKey(c.charge.dueDate) !== m.month) continue
                    billed += cents(c.charge.amount)
                    applied += c.appliedCents
                }
            }
            const leased = new Set(leases.filter((l) => isActiveOn(l, end) && activeUnitIds.has(l.unitId)).map((l) => l.unitId))
            return {
                month: m.month, label: monthLabel(m.month), billed: m.billed, collected: m.collected,
                collectionRate: ratio(applied, billed), expenses: m.expenses, noi: m.net,
                occupancy: ratio(leased.size, units.length),
            }
        })

        // Property by property.
        const perProperty: PropertyPerformance[] = properties.map((prop) => {
            const propUnits = units.filter((u) => u.propertyId === prop.id)
            const unitIds = new Set(propUnits.map((u) => u.id))
            const leaseIds = new Set([...book.where.entries()].filter(([, w]) => w.propertyId === prop.id).map(([id]) => id))
            const live = activeNow.filter((l) => unitIds.has(l.unitId))
            const s = stats(leaseIds)
            const cash = this.cashIn(book, from, today, leaseIds).cash
            const spent = expenses.filter((e) => e.propertyId === prop.id && inRange(e.spentOn, from, today)).reduce((sum, e) => sum + cents(e.amount), 0)
            const roll = live.reduce((sum, l) => sum + cents(l.monthlyRent), 0)
            return {
                id: prop.id,
                name: prop.name,
                units: propUnits.length,
                occupied: new Set(live.map((l) => l.unitId)).size,
                occupancy: ratio(new Set(live.map((l) => l.unitId)).size, propUnits.length),
                rentRoll: dollars(roll),
                avgRent: live.length ? round2(dollars(roll) / live.length) : 0,
                billed12m: dollars(s.billed),
                collected12m: dollars(cash),
                collectionRate: ratio(s.applied, s.billed),
                expenses12m: dollars(spent),
                noi12m: dollars(cash - spent),
                outstanding: dollars([...leaseIds].reduce((sum, id) => sum + Math.max(0, cents(book.balance.get(id) ?? 0)), 0)),
                openMaintenance: openTimings.filter((t) => unitIds.has(t.unitId)).length,
                expiring90: expiring.filter((l) => unitIds.has(l.unitId)).length,
            }
        })

        const occupied = new Set(activeNow.map((l) => l.unitId)).size
        return {
            asOf: today,
            lateAfterDays: LATE_AFTER_DAYS,
            kpis: {
                units: units.length,
                occupied,
                vacant: units.length - occupied,
                occupancy: ratio(occupied, units.length),
                rentRoll: dollars(rentRoll),
                avgRent: activeNow.length ? round2(dollars(rentRoll) / activeNow.length) : 0,
                billed12m: dollars(all.billed),
                collected12m: dollars(cash12),
                collectionRate12m: ratio(all.applied, all.billed),
                expenses12m: dollars(spent12),
                noi12m: dollars(cash12 - spent12),
                outstanding: dollars(outstanding),
                delinquencyRate: ratio(outstanding, rentRoll),
                onTimeRate: ratio(all.onTime, all.onTimeDue),
                avgDaysToPay: all.paidRent ? Math.round((all.paidDays / all.paidRent) * 10) / 10 : 0,
                openMaintenance: openTimings.length,
                avgResolutionDays: avgResolution,
                expiring90: expiring.length,
            },
            trend,
            properties: perProperty,
            maintenance: {
                submitted: timings.filter((t) => t.status === "submitted").length,
                inProgress: timings.filter((t) => t.status === "in_progress").length,
                resolved12m: resolved12.length,
                avgResolutionDays: avgResolution,
                oldestOpenDays: oldestOpen,
            },
        }
    }

    // ---- Leases ending soon, and the renewal notice

    async expiring(days: number): Promise<ExpiringLeaseRow[]> {
        const [book, notices] = await Promise.all([this.book(), this.db.listRenewalNotices()])
        const { today } = book
        const until = addDays(today, days)
        const last = new Map(notices.map((n) => [n.leaseId, n]))
        return [...book.leases.values()]
            .filter((l) => l.endDate !== null && l.endDate >= today && l.endDate <= until)
            .map((l) => {
                const w = book.where.get(l.id)
                const n = last.get(l.id)
                return {
                    leaseId: l.id,
                    unitLabel: this.unitLabel(book, l.id),
                    propertyId: w?.propertyId ?? 0,
                    propertyName: w?.propertyName ?? "",
                    tenants: book.residents.get(l.id) ?? [],
                    endDate: l.endDate!,
                    daysLeft: daysBetween(today, l.endDate!),
                    monthlyRent: l.monthlyRent,
                    balance: book.balance.get(l.id) ?? 0,
                    lastNotice: n ? { sentAt: n.sentAt.toISOString(), recipients: n.recipients } : null,
                }
            })
            .sort((a, b) => a.daysLeft - b.daysLeft)
    }

    /** The default renewal message (the office can edit it before sending). */
    async renewalDraft(leaseId: number): Promise<string> {
        const lease = await this.db.findLease(leaseId)
        if (!lease || lease.endDate === null) throw new AppError("NOT_FOUND")
        const tenants = await this.db.listLeaseTenants(leaseId)
        const names = tenants.map((t) => t.name.split(" ")[0]).join(" and ") || "there"
        const days = daysBetween(this.today(), lease.endDate)
        const when = formatDate(new Date(`${lease.endDate}T12:00:00Z`), "UTC")
        return `Hi ${names}, your lease for Unit ${lease.unitNum} at ${lease.propertyName} ends on ${when} (${days} day${days === 1 ? "" : "s"} from today). ` +
            "Please reply here to let us know whether you would like to renew or plan to move out, so we can get the paperwork ready. Thank you!"
    }

    /** Message every resident on the lease, and record that the notice went out. Returns how many were messaged. */
    async sendRenewalNotice(staffUserId: string, leaseId: number, body?: string): Promise<number> {
        const owner = parseUserId(staffUserId)
        if (!owner || owner.table !== "admin") throw new AppError("FORBIDDEN")
        const lease = await this.db.findLease(leaseId)
        if (!lease || lease.endDate === null) throw new AppError("NOT_FOUND")
        const tenants = await this.db.listLeaseTenants(leaseId)
        if (!tenants.length) throw new AppError("VALIDATION_ERROR")
        const text = (body?.trim() || (await this.renewalDraft(leaseId))).slice(0, 2000)
        return this.log.flow("office.lease.renewal_notice", { by: staffUserId, leaseId, recipients: tenants.length }, async () => {
            for (const t of tenants) await this.db.sendMessage({ tenantId: t.id, adminId: owner.id, body: text })
            await this.db.recordRenewalNotice(leaseId, tenants.length)
            return tenants.length
        })
    }

    // ---- Cash App / Zelle payments tenants reported (006)

    async reportedPayments(pendingOnly: boolean): Promise<ReportedPaymentRow[]> {
        const [reports, locations, balances] = await Promise.all([
            this.db.listReportedPayments({ pendingOnly }),
            this.db.listLeaseLocations(),
            this.db.listLeaseBalances(),
        ])
        const where = new Map(locations.map((l) => [l.leaseId, l]))
        const balance = new Map(balances.map((b) => [b.leaseId, b.balance]))
        return reports.slice(0, pendingOnly ? 200 : 60).map((r) => this.reportRow(r, where.get(r.leaseId), balance.get(r.leaseId) ?? 0))
    }

    private reportRow(r: ReportedPaymentRecord, w: { unitNum: string; propertyName: string } | undefined, balance: number): ReportedPaymentRow {
        return {
            id: r.id,
            leaseId: r.leaseId,
            unitLabel: w ? `Unit ${w.unitNum}` : "Unit",
            propertyName: w?.propertyName ?? "",
            tenantName: r.reportedByName,
            method: r.method,
            amount: r.amount,
            reportedAt: r.reportedAt.toISOString(),
            confirmation: r.confirmation,
            balance,
            status: r.status === "pending" ? "pending" : r.decision === "rejected" ? "rejected" : "confirmed",
            reason: r.reason,
            reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
            reviewedBy: r.reviewedBy,
        }
    }

    /**
     * The office found the money in its Cash App / Zelle: the payment counts
     * now. Or it didn't: rejected with a reason, and the tenant is told by message.
     */
    // logs office.payment_report.confirmed / .rejected { by, payId, leaseId, amount }
    async reviewReport(staffUserId: string, payId: number, decision: "confirmed" | "rejected", reason: string | null): Promise<ReportedPaymentRow> {
        const owner = parseUserId(staffUserId)
        if (!owner || owner.table !== "admin") throw new AppError("FORBIDDEN")
        if (decision === "rejected" && !reason?.trim()) throw new AppError("VALIDATION_ERROR")
        return this.log.flow(`office.payment_report.${decision}`, { by: staffUserId, payId }, async () => {
            const record = await this.db.reviewReportedPayment(payId, decision, decision === "rejected" ? reason!.trim() : null)
            const app = MANUAL_PAY_LABELS[record.method]
            const amount = record.amount.toLocaleString("en-US", { style: "currency", currency: "USD" })
            const when = formatDate(record.reportedAt, this.timeZone)
            await this.db.sendMessage({
                tenantId: record.reportedBy,
                adminId: owner.id,
                body: decision === "confirmed"
                    ? `We received your ${app} payment of ${amount} (reported ${when}). It's now on your ledger. Thank you!`
                    : `We couldn't match your ${app} payment of ${amount} (reported ${when}): ${record.reason}. Please check your ${app} app and reply here, or pay again from the Pay rent page.`,
            })
            const [locations, balances] = await Promise.all([this.db.listLeaseLocations(), this.db.listLeaseBalances()])
            return this.reportRow(record, locations.find((l) => l.leaseId === record.leaseId), balances.find((b) => b.leaseId === record.leaseId)?.balance ?? 0)
        }, (row) => ({ leaseId: row.leaseId, amount: row.amount }))
    }

    // ---- Office settings (006): where tenants send Cash App / Zelle payments

    async officeSettings(): Promise<OfficeSettings> {
        const o = await this.db.getOfficeSettings()
        return { cashappHandle: o.cashappHandle, zelleHandle: o.zelleHandle, updatedAt: o.updatedAt ? o.updatedAt.toISOString() : null, updatedBy: o.updatedBy }
    }

    // logs office.settings.update { cashapp: set|cleared, zelle: set|cleared }
    async updateOfficeSettings(input: { cashappHandle: string | null; zelleHandle: string | null }): Promise<OfficeSettings> {
        await this.log.flow("office.settings.update", { cashapp: input.cashappHandle ? "set" : "cleared", zelle: input.zelleHandle ? "set" : "cleared" },
            () => this.db.updateOfficeSettings(input))
        return this.officeSettings()
    }

    // ---- Expenses

    addExpense(input: NewExpense): Promise<number> {
        return this.log.flow("office.expense.add", { category: input.category, amount: input.amount, propertyId: input.propertyId }, () => this.db.addExpense(input), (id) => ({ expenseId: id }))
    }

    voidExpense(expId: number): Promise<void> {
        return this.log.flow("office.expense.void", { expenseId: expId }, () => this.db.voidExpense(expId))
    }
}
