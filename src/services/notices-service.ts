import { currentIdentity } from "../db/identity"
import { silentLogger, type LogMetadata, type LogService } from "../logging"
import type {
    DocumentCategory, DocumentChange, DocumentScope, HubDocument, HubFilter, NoticeAudience, NoticeFilter, NoticeRow, StoredFile, TenantDocument, TenantNotice,
} from "../types/additions"
import { AppError } from "../types/errors"
import type { AdditionsStore } from "../types/stores"
import { DOCUMENT_MAX_BYTES, DOCUMENT_TYPES, readUpload } from "../utils/uploads"
import { localDate } from "./ledger"

export const DOCUMENT_CATEGORIES: Array<[DocumentCategory, string]> = [
    ["lease", "Lease agreements"],
    ["inspection", "Inspections"],
    ["insurance", "Insurance"],
    ["notice", "Notices"],
    ["receipt", "Receipts"],
    ["other", "Other documents"],
]

/** Lease PDFs on file (operations' Lease_Documents), as the tenant sees theirs. */
export interface LeaseDocumentSource {
    findLeaseDocumentMeta(leaseId: number): Promise<{ filename: string; uploadedAt: Date } | null>
    findCurrentLease(tID: number, today: string): Promise<{ id: number } | null>
}

/**
 * Notices to residents and the documents the office keeps (009). Staff write
 * notices (in-app; email is not set up on this server) and file documents
 * against a property, unit, tenant or lease, sharing any with the resident.
 */
export class NoticesService {
    /** No email provider is configured: notices go to the resident portal only. */
    readonly emailEnabled = false

    constructor(
        private readonly db: AdditionsStore,
        private readonly leases: LeaseDocumentSource,
        private readonly timeZone: string,
        private readonly log: LogService = silentLogger,
    ) {}

    private today() {
        return localDate(new Date(), this.timeZone)
    }

    private change<T>(event: string, metadata: LogMetadata, work: () => Promise<T>): Promise<T> {
        const who = currentIdentity()
        return this.log.flow(event, { by: "id" in who ? `${who.type}:${who.id}` : who.type, ...metadata }, work)
    }

    /* ---- Notices ---- */

    notices(filter: NoticeFilter): Promise<NoticeRow[]> {
        return this.db.listNotices(filter)
    }

    send(audience: NoticeAudience, subject: string, body: string): Promise<{ recipients: number; emailsQueued: number; emailsSkipped: number }> {
        return this.change("office.notice.send", { audience: audience.kind }, async () => ({
            recipients: await this.db.sendNotice(audience, subject, body, this.today()),
            emailsQueued: 0,
            emailsSkipped: 0,
        }))
    }

    tenantNotices(): Promise<TenantNotice[]> {
        return this.db.tenantNotices()
    }

    markRead(id: number): Promise<void> {
        return this.db.markNoticeRead(id)
    }

    /* ---- Documents ---- */

    hub(filter: HubFilter): Promise<HubDocument[]> {
        return this.db.listHubDocuments(filter)
    }

    upload(input: { scope: DocumentScope; scopeId: number; category: DocumentCategory; title: string; sharedWithTenant: boolean; file: unknown }): Promise<number> {
        const file = readUpload(input.file, DOCUMENT_TYPES, DOCUMENT_MAX_BYTES)
        return this.change("office.document.upload", { scope: input.scope, scopeId: input.scopeId }, () => this.db.addDocument({ ...input, file }))
    }

    update(id: number, change: DocumentChange): Promise<void> {
        return this.change("office.document.update", { documentId: id }, () => this.db.updateDocument(id, change))
    }

    hide(id: number): Promise<void> {
        return this.change("office.document.hide", { documentId: id }, () => this.db.hideDocument(id))
    }

    async file(id: number): Promise<StoredFile> {
        const file = await this.db.documentFile(id)
        if (!file) throw new AppError("NOT_FOUND")
        return file
    }

    /** The tenant's documents, grouped: their signed lease and whatever the office shared. */
    async tenantDocuments(tID: number): Promise<Array<{ category: DocumentCategory; label: string; documents: TenantDocument[] }>> {
        const [shared, lease] = await Promise.all([this.db.tenantDocuments(), this.leases.findCurrentLease(tID, this.today())])
        const pdf = lease ? await this.leases.findLeaseDocumentMeta(lease.id) : null
        return DOCUMENT_CATEGORIES.map(([category, label]) => ({
            category,
            label,
            documents: [
                ...(category === "lease" && pdf
                    ? [{ id: 0, kind: "lease_pdf" as const, title: "Your signed lease", filename: pdf.filename, uploadedAt: pdf.uploadedAt.toISOString(), href: "/api/tenant/lease-document" }]
                    : []),
                ...shared.filter((d) => d.category === category).map(({ category: _c, ...d }) => d),
            ],
        }))
    }
}
