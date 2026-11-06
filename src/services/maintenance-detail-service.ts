import { currentIdentity } from "../db/identity"
import { silentLogger, type LogMetadata, type LogService } from "../logging"
import type { MaintenanceDetail, MaintenanceSummary, MaintenanceWorkInput, StoredFile, TenantPhoto } from "../types/additions"
import { AppError } from "../types/errors"
import type { AdditionsStore } from "../types/stores"
import { PHOTO_MAX_BYTES, PHOTO_TYPES, readUpload } from "../utils/uploads"
import { localDate } from "./ledger"

/**
 * One maintenance request in detail (009): its history, who it is assigned
 * to, what it cost (booked once as a repairs expense), staff notes and photos
 * from staff or the resident. Property managers and maintenance staff; the
 * resident can add photos to their own open request and see them.
 */
export class MaintenanceDetailService {
    constructor(
        private readonly db: AdditionsStore,
        private readonly timeZone: string,
        private readonly log: LogService = silentLogger,
    ) {}

    private change<T>(event: string, metadata: LogMetadata, work: () => Promise<T>): Promise<T> {
        const who = currentIdentity()
        return this.log.flow(event, { by: "id" in who ? `${who.type}:${who.id}` : who.type, ...metadata }, work)
    }

    async detail(id: number): Promise<MaintenanceDetail> {
        const detail = await this.db.maintenanceDetail(id)
        if (!detail) throw new AppError("NOT_FOUND")
        return detail
    }

    /** The queue over the last `days` days: what came in by stage, priority and type; what is open now; how long completion took. */
    async summary(days: number): Promise<MaintenanceSummary> {
        const since = new Date(Date.now() - days * 86_400_000).toISOString()
        const rows = await this.db.maintenanceForSummary(since)
        const recent = rows.filter((r) => r.recent)
        const count = (key: "status" | "priority" | "requestType") => {
            const out: Record<string, number> = {}
            for (const r of recent) out[r[key]] = (out[r[key]] ?? 0) + 1
            return out
        }
        const completed = rows.filter((r) => r.status === "resolved" && r.completedAt && r.completedAt.getTime() >= Date.parse(since))
        const average = completed.length
            ? Math.round((completed.reduce((s, r) => s + (r.completedAt!.getTime() - r.createdAt.getTime()) / 86_400_000, 0) / completed.length) * 10) / 10
            : null
        return { days, byStatus: count("status"), byPriority: count("priority"), byType: count("requestType"), open: rows.filter((r) => r.open).length, averageDaysToComplete: average }
    }

    updateWork(id: number, input: MaintenanceWorkInput): Promise<void> {
        return this.change("office.maintenance.work", { requestId: id }, () => this.db.updateMaintenanceWork(id, input))
    }

    addNote(id: number, body: string): Promise<number> {
        return this.change("office.maintenance.note", { requestId: id }, () => this.db.addMaintenanceNote(id, body))
    }

    addStaffPhoto(id: number, body: unknown): Promise<number> {
        const who = currentIdentity()
        if (who.type !== "admin") throw new AppError("FORBIDDEN")
        const file = readUpload(body, PHOTO_TYPES, PHOTO_MAX_BYTES)
        return this.change("office.maintenance.photo", { requestId: id }, () => this.db.addMaintenancePhoto(id, file, { adminId: who.id }))
    }

    async photo(id: number, attachmentId: number): Promise<StoredFile> {
        const file = await this.db.maintenancePhoto(id, attachmentId)
        if (!file) throw new AppError("NOT_FOUND")
        return file
    }

    recordExpense(id: number): Promise<number> {
        return this.change("office.maintenance.expense", { requestId: id }, () => this.db.recordMaintenanceExpense(id, localDate(new Date(), this.timeZone)))
    }

    /* ---- The resident's side ---- */

    /** Photos on the tenant's own requests (row-level security hides the rest). */
    tenantPhotos(requestIds: number[]): Promise<Record<string, TenantPhoto[]>> {
        return requestIds.length ? this.db.tenantPhotos(requestIds) : Promise.resolve({})
    }

    addTenantPhoto(id: number, body: unknown): Promise<number> {
        const who = currentIdentity()
        if (who.type !== "tenant") throw new AppError("FORBIDDEN")
        const file = readUpload(body, PHOTO_TYPES, PHOTO_MAX_BYTES)
        return this.change("tenant.maintenance.photo", { requestId: id }, () => this.db.addMaintenancePhoto(id, file, { tenantId: who.id }))
    }
}
