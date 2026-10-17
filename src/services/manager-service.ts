import { AppError } from "../types/errors"
import type { InviteToken, LeaseChanges, NewLease, PropertyInput, TenantChanges, UnitInput } from "../types/inputs"
import type { CreatedLeaseResult, DashboardData, InviteResult, LeaseDetail, MaintenanceRow, PropertySummary, TenantRow, UnitRow, UpdateRow } from "../types/manager"
import type { LeaseRecord, MaintenanceState, Receipt } from "../types/records"
import type { ManagerStore } from "../types/stores"
import { officeConfirmation } from "../utils/confirmations"
import { newInvite } from "../utils/tokens"
import { parseUserId } from "../utils/user-id"
import { buildLedger, formatDate, localDate } from "./ledger"

/**
 * The office side: the rent roll, tenants, leases, payments and the dashboard,
 * worked out from store records. Balances come from the `lease_balance` view.
 * Every manager sees every property, so nothing is filtered by assignment.
 */

type ActiveLease = { lease: LeaseRecord; balance: number }

const isActive = (lease: LeaseRecord, today: string) =>
    lease.startDate <= today && (lease.endDate === null || lease.endDate >= today)

const inviteResult = (tenantId: number, email: string, { token, invite }: { token: string; invite: InviteToken }): InviteResult =>
    ({ tenantId, email, inviteToken: token, expiresAt: invite.expiresAt.toISOString() })

export class ManagerService {
    constructor(
        private readonly db: ManagerStore,
        private readonly timeZone: string,
    ) {}


    /** Today's date (YYYY-MM-DD) in the portal's time zone. */
    private today(): string {
        return localDate(new Date(), this.timeZone)
    }

    // ---- Balances (one query for every lease, shared by every screen)

    private async activeLeases(): Promise<Map<number, ActiveLease>> {
        const today = this.today()
        const [allLeases, balances] = await Promise.all([this.db.listLeases(), this.db.listLeaseBalances()])
        const balanceOf = new Map(balances.map((b) => [b.leaseId, b.balance]))

        const out = new Map<number, ActiveLease>()
        for (const lease of allLeases.filter((l) => isActive(l, today))) {
            out.set(lease.id, { lease, balance: balanceOf.get(lease.id) ?? 0 })
        }
        return out
    }

    private async leaseTenants(): Promise<Map<number, Array<{ id: number; name: string }>>> {
        const out = new Map<number, Array<{ id: number; name: string }>>()
        for (const r of await this.db.listLeaseResidents()) {
            out.set(r.leaseId, [...(out.get(r.leaseId) ?? []), { id: r.tenantId, name: r.name }])
        }
        return out
    }

    // ---- Units (the rent roll) and properties

    async units(propertyId?: number): Promise<UnitRow[]> {
        const [active, people, units, open] = await Promise.all([
            this.activeLeases(),
            this.leaseTenants(),
            this.db.listUnits(propertyId),
            this.db.listOpenRequestCounts(),
        ])
        const leaseByUnit = new Map<number, ActiveLease>()
        for (const entry of active.values()) {
            const existing = leaseByUnit.get(entry.lease.unitId)
            if (!existing || existing.lease.startDate < entry.lease.startDate) leaseByUnit.set(entry.lease.unitId, entry)
        }
        const openByUnit = new Map(open.map((r) => [r.unitId, r.count]))

        return units.map((u): UnitRow => {
            const current = leaseByUnit.get(u.id)
            const balance = current?.balance ?? 0
            return {
                id: u.id,
                propertyId: u.propertyId,
                propertyName: u.propertyName,
                unitNum: u.unitNum,
                leaseId: current?.lease.id ?? null,
                tenants: current ? people.get(current.lease.id) ?? [] : [],
                monthlyRent: current ? current.lease.monthlyRent : null,
                balance,
                startDate: current?.lease.startDate ?? null,
                endDate: current?.lease.endDate ?? null,
                status: !current ? "vacant" : balance > 0 ? "owing" : "current",
                openRequests: openByUnit.get(u.id) ?? 0,
            }
        })
    }

    async properties(): Promise<PropertySummary[]> {
        const [props, units] = await Promise.all([this.db.listProperties(), this.units()])
        return props.map((p) => {
            const mine = units.filter((u) => u.propertyId === p.id)
            return {
                id: p.id,
                name: p.name,
                address: p.address,
                units: mine.length,
                occupied: mine.filter((u) => u.status !== "vacant").length,
                monthlyRent: mine.reduce((sum, u) => sum + (u.monthlyRent ?? 0), 0),
                outstanding: mine.reduce((sum, u) => sum + Math.max(0, u.balance), 0),
            }
        })
    }

    saveProperty(id: number | null, input: PropertyInput): Promise<number> {
        return this.db.saveProperty(id, input)
    }

    saveUnit(id: number | null, input: UnitInput): Promise<number> {
        return this.db.saveUnit(id, input)
    }

    // ---- Tenants

    async tenants(): Promise<TenantRow[]> {
        const [people, active, links, units] = await Promise.all([
            this.db.listPeople(),
            this.activeLeases(),
            this.db.listLeaseResidents(),
            this.db.listUnits(),
        ])
        const unitLabel = new Map(units.map((u) => [u.id, `Unit ${u.unitNum} - ${u.propertyName}`]))
        return people.map((t) => {
            const lease = links.map((l) => (l.tenantId === t.id ? active.get(l.leaseId) : undefined)).find(Boolean)
            return {
                id: t.id,
                name: t.name,
                email: t.email,
                phone: t.phone,
                signedUp: t.signedUp,
                leaseId: lease?.lease.id ?? null,
                unitLabel: lease ? unitLabel.get(lease.lease.unitId) ?? null : null,
                balance: lease?.balance ?? 0,
            }
        })
    }

    /** The office adds a tenant; they sign up later from the invitation link. */
    async inviteTenant(input: { name: string; email: string; phone: string | null }): Promise<InviteResult> {
        const fresh = newInvite()
        const invited = await this.db.inviteTenant({ ...input, invite: fresh.invite })
        return inviteResult(parseUserId(invited.id)!.id, invited.email, fresh)
    }

    /** A new link for a tenant who has not signed up; the old one stops working. */
    async reissueInvite(tID: number): Promise<InviteResult> {
        const person = await this.db.findPerson(tID)
        if (!person) throw new AppError("NOT_FOUND")
        const fresh = newInvite()
        await this.db.reissueInvite(tID, fresh.invite)
        return inviteResult(tID, person.email, fresh)
    }

    updateTenant(tID: number, input: TenantChanges): Promise<void> {
        return this.db.updateTenant(tID, input)
    }

    // ---- Leases

    async lease(leaseId: number): Promise<LeaseDetail> {
        const lease = await this.db.findLease(leaseId)
        if (!lease) throw new AppError("NOT_FOUND")
        const [charges, payments, people, receiptPaymentIds] = await Promise.all([
            this.db.listChargesForLease(leaseId),
            this.db.listPaymentsForLease(leaseId),
            this.db.listLeaseTenants(leaseId),
            this.db.listReceiptPaymentIds(leaseId),
        ])
        const { balance, entries } = buildLedger(charges, payments, this.timeZone)
        return { ...lease, tenants: people, balance, ledger: entries, receiptPaymentIds }
    }

    /** A lease with existing tenants and/or new ones, who are invited. Returns one invitation per new tenant. */
    async createLease(input: {
        unitId: number; startDate: string; endDate: string | null; monthlyRent: number
        tenantIds: number[]; newTenants: Array<{ name: string; email: string; phone: string | null }>
    }): Promise<CreatedLeaseResult> {
        if (input.tenantIds.length + input.newTenants.length === 0) throw new AppError("VALIDATION_ERROR")
        if (input.endDate && input.endDate < input.startDate) throw new AppError("VALIDATION_ERROR")

        const invites = input.newTenants.map((person) => ({ person, ...newInvite() }))
        const request: NewLease = { ...input, newTenants: invites.map(({ person, invite }) => ({ ...person, invite })) }
        const created = await this.db.createLease(request, this.today())
        return {
            id: created.leaseId,
            invites: invites.map((fresh, i) => inviteResult(created.newTenantIds[i]!, fresh.person.email.trim().toLowerCase(), fresh)),
        }
    }

    async updateLease(leaseId: number, input: LeaseChanges): Promise<void> {
        await this.db.updateLease(leaseId, input)
        // A longer lease can mean months that now need billing.
        await this.db.generateRentCharges(this.today(), leaseId)
    }

    /** An existing tenant, or a new one (returned with their invitation). */
    async addTenantToLease(leaseId: number, input: { tenantId?: number; newTenant?: { name: string; email: string; phone: string | null } }): Promise<InviteResult | null> {
        if (!input.newTenant) {
            await this.db.addTenantToLease(leaseId, { tenantId: input.tenantId })
            return null
        }
        const fresh = newInvite()
        const tenantId = await this.db.addTenantToLease(leaseId, { newTenant: { ...input.newTenant, invite: fresh.invite } })
        return inviteResult(tenantId, input.newTenant.email.trim().toLowerCase(), fresh)
    }

    removeTenantFromLease(leaseId: number, tID: number): Promise<void> {
        return this.db.removeTenantFromLease(leaseId, tID)
    }

    /** A payment the office received (check, cash, money order). Returns the confirmation number. */
    async recordPayment(
        leaseId: number,
        input: { amount: number; method: string; tenantId: number | null; receipt?: Receipt | null },
    ): Promise<string> {
        const confirmation = officeConfirmation()
        await this.db.recordPayment({
            leaseId,
            amount: input.amount,
            tenantId: input.tenantId,
            method: `${input.method} (recorded by office)`.slice(0, 60),
            confirmation,
            receipt: input.receipt,
        })
        return confirmation
    }

    // ---- Receipts

    attachReceipt(leaseId: number, payId: number, receipt: Receipt): Promise<void> {
        return this.db.attachReceipt(leaseId, payId, receipt)
    }

    async receipt(leaseId: number, payId: number): Promise<Receipt> {
        const found = await this.db.findReceipt(leaseId, payId)
        if (!found) throw new AppError("NOT_FOUND")
        return found
    }

    // ---- Maintenance

    async maintenance(): Promise<MaintenanceRow[]> {
        const rows = await this.db.listMaintenance()
        return rows.map(({ createdAt, ...r }) => ({ ...r, submittedDate: formatDate(createdAt, this.timeZone) }))
    }

    async createMaintenance(input: { unitId: number; title: string; description: string }): Promise<number> {
        const created = await this.db.createMaintenance({ ...input, tenantId: null })
        return created.id
    }

    setMaintenanceStatus(id: number, status: MaintenanceState): Promise<void> {
        return this.db.setMaintenanceStatus(id, status)
    }

    // ---- Retiring records (nothing is deleted; history stays on record)

    deactivateTenant(tID: number): Promise<void> {
        return this.db.deactivateTenant(tID, this.today())
    }

    /** Undo an office payment with a matching refund. (A lease is ended with updateLease, never deleted.) */
    reverseOfficePayment(leaseId: number, payId: number): Promise<void> {
        return this.db.reverseOfficePayment(leaseId, payId)
    }

    deactivateUnit(uID: number): Promise<void> {
        return this.db.deactivateUnit(uID, this.today())
    }

    deactivateProperty(pID: number): Promise<void> {
        return this.db.deactivateProperty(pID, this.today())
    }

    deactivateMaintenance(mID: number): Promise<void> {
        return this.db.deactivateMaintenance(mID)
    }

    /** The signed-in staff member, for the sidebar. */
    async staffProfile(userId: string): Promise<{ name: string; email: string; role: string }> {
        const owner = parseUserId(userId)
        if (!owner || owner.table !== "admin") throw new AppError("NOT_FOUND")
        const profile = await this.db.findStaffProfile(owner.id)
        if (!profile) throw new AppError("NOT_FOUND")
        return profile
    }

    // ---- Dashboard and Updates

    async updates(): Promise<UpdateRow[]> {
        const [units, maintenance, tenants] = await Promise.all([this.units(), this.maintenance(), this.tenants()])
        const out: UpdateRow[] = []
        for (const u of units.filter((x) => x.status === "owing")) {
            const months = u.monthlyRent ? u.balance / u.monthlyRent : 0
            out.push({
                kind: "overdue",
                title: months >= 1.5 ? "Past due more than a month" : "Rent outstanding",
                detail: `${u.tenants.map((t) => t.name).join(", ") || "No tenant"} owes ${u.balance.toLocaleString("en-US", { style: "currency", currency: "USD" })}.`,
                leaseId: u.leaseId,
                unitLabel: `Unit ${u.unitNum} - ${u.propertyName}`,
                amount: u.balance,
                severity: months >= 1.5 ? 80 : 50,
            })
        }
        for (const m of maintenance.filter((x) => x.status === "submitted")) {
            out.push({
                kind: "maintenance_new",
                title: `New maintenance request: ${m.title}`,
                detail: `${m.tenantName ?? "Filed by the office"} · submitted ${m.submittedDate}`,
                leaseId: units.find((u) => u.id === m.unitId)?.leaseId ?? null,
                unitLabel: `Unit ${m.unitNum} - ${m.propertyName}`,
                amount: null,
                severity: 60,
            })
        }
        for (const t of tenants.filter((x) => !x.signedUp && x.leaseId !== null)) {
            out.push({
                kind: "not_signed_up",
                title: "Has not signed up yet",
                detail: `${t.name} (${t.email}) was added but has not created a password.`,
                leaseId: t.leaseId,
                unitLabel: t.unitLabel ?? "",
                amount: null,
                severity: 20,
            })
        }
        return out.sort((a, b) => b.severity - a.severity || (b.amount ?? 0) - (a.amount ?? 0))
    }

    async dashboard(): Promise<DashboardData> {
        const [units, propertyCount, updates, maintenance, payments] = await Promise.all([
            this.units(),
            this.db.countProperties(),
            this.updates(),
            this.maintenance(),
            this.db.listRecentPayments(200),
        ])
        const now = new Date()
        const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
        const occupied = units.filter((u) => u.status !== "vacant")
        const collectedThisMonth = payments
            .filter((p) => p.paidAt >= monthStart)
            .reduce((sum, p) => sum + p.amount, 0)
        const activity = [
            ...payments.slice(0, 8).map((p) => ({
                kind: "payment" as const,
                title: "Payment received",
                detail: `${p.payer ?? "Office"} · Unit ${p.unitNum} · ${p.amount.toLocaleString("en-US", { style: "currency", currency: "USD" })}`,
                when: formatDate(p.paidAt, this.timeZone),
                at: p.paidAt.toISOString(),
            })),
            ...maintenance.slice(0, 8).map((m) => ({
                kind: "maintenance" as const,
                title: m.status === "resolved" ? "Maintenance completed" : "Maintenance request",
                detail: `Unit ${m.unitNum} · ${m.title}`,
                when: m.submittedDate,
                at: new Date(Date.parse(m.submittedDate)).toISOString(),
            })),
        ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8)

        return {
            properties: propertyCount,
            units: units.length,
            occupied: occupied.length,
            vacant: units.length - occupied.length,
            expectedThisMonth: occupied.reduce((sum, u) => sum + (u.monthlyRent ?? 0), 0),
            collectedThisMonth: Math.round(collectedThisMonth * 100) / 100,
            outstanding: Math.round(units.reduce((sum, u) => sum + Math.max(0, u.balance), 0) * 100) / 100,
            overdueAccounts: units.filter((u) => u.status === "owing").length,
            openMaintenance: maintenance.filter((m) => m.status !== "resolved").length,
            recentActivity: activity,
            updates: updates.slice(0, 6),
        }
    }
}
