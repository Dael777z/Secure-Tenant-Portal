/**
 * Types for the 009 screens: office tools (team, activity, portfolios, details,
 * compliance, reports, search), maintenance detail, leasing (listings, leads,
 * the public page), notices and documents. Field names are the JSON the
 * frontend reads.
 */
import type { StaffRole } from "./access"

/* ---- Team ---- */
export type StaffStatus = "active" | "invited" | "deactivated"
export interface TeamMember {
    id: number
    name: string
    email: string
    role: StaffRole
    status: StaffStatus
    mfaEnabled: boolean
    lastLoginAt: string | null
}
export interface StaffInvite {
    tokenHash: string
    expiresAt: Date
}

/* ---- Activity ---- */
export type ActivityKind = "change" | "security"
export interface ActivityEntry {
    at: string
    by: string | null
    byName: string | null
    kind: ActivityKind
    table: string | null
    rowPk: string | null
    action: string
    summary: string
    details: unknown
}
export interface ActivityFilter {
    kind: ActivityKind | null
    table: string | null
    since: string | null
    limit: number
}
export interface AuditRow {
    at: string
    by: string | null
    table: string
    rowPk: string
    action: "INSERT" | "UPDATE" | "DELETE"
    before: Record<string, unknown> | null
    after: Record<string, unknown> | null
}
export interface SecurityEventRow {
    at: string
    by: string | null
    action: string
    summary: string
    details: unknown
}

/* ---- Portfolios and details ---- */
export interface PortfolioRecord {
    id: number
    name: string
    entityName: string | null
    notes: string | null
    createdBy: string | null
    createdAt: string
}
export interface PortfolioInput {
    name: string
    entityName: string | null
    notes: string | null
}
export interface PropertyDetails {
    propertyId: number
    name: string
    address: string
    portfolioId: number | null
    portfolioName: string | null
    city: string | null
    state: string | null
    zip: string | null
    timeZone: string | null
    notes: string | null
}
export type PropertyDetailsInput = Pick<PropertyDetails, "portfolioId" | "city" | "state" | "zip" | "timeZone" | "notes">

export type InsuranceStatus = "not_required" | "required" | "on_file" | "expired"
export interface TenantDetails {
    tenantId: number
    notes: string | null
    insuranceStatus: InsuranceStatus
    insuranceExpires: string | null
    emergencyContactName: string | null
    emergencyContactPhone: string | null
    updatedAt: string | null
    updatedBy: string | null
}
export type TenantDetailsInput = Omit<TenantDetails, "tenantId" | "updatedAt" | "updatedBy">

/* ---- Compliance ---- */
export interface ComplianceSettings {
    state: string
    securityDepositMaxMonths: number | null
    depositInterestRequired: boolean | null
    lateFeeGraceDays: number | null
    lateFeeMaxPercent: number | null
    noticeToQuitDays: number | null
    rentIncreaseNoticeDays: number | null
    leadPaintDisclosureRequired: boolean | null
    notes: string | null
    references: string | null
    confirmedAt: string | null
    confirmedBy: string | null
    updatedAt: string
    updatedBy: string | null
}
export type ComplianceInput = Omit<ComplianceSettings, "confirmedAt" | "confirmedBy" | "updatedAt" | "updatedBy">
export interface ComplianceWarning {
    code: "deposit_above_max" | "grace_below_min" | "late_fee_above_max"
    message: string
    unitId: number | null
}
export interface DepositRow {
    leaseId: number
    unitId: number
    unitLabel: string
    monthlyRent: number
    deposits: number
}

/* ---- Reports ---- */
export interface ReportInfo {
    key: string
    name: string
    description: string
    href: string
    filters: Array<"from" | "to" | "year">
}

/* ---- Search ---- */
export type SearchKind = "tenant" | "unit" | "property" | "portfolio" | "maintenance" | "listing" | "document" | "payment"
export interface SearchHit {
    kind: SearchKind
    id: number
    title: string
    detail: string | null
    tenantId: number | null
    unitId: number | null
    leaseId: number | null
}

/* ---- Maintenance detail ---- */
export interface MaintenanceNote {
    id: number
    body: string
    author: string | null
    createdAt: string
}
export interface MaintenanceAttachment {
    id: number
    filename: string
    sizeBytes: number
    uploadedBy: string | null
    fromTenant: boolean
    uploadedAt: string
}
export interface MaintenanceDetail {
    id: number
    title: string
    description: string
    status: string
    priority: string
    requestType: string
    scheduledFor: string | null
    createdAt: string
    updatedAt: string
    completedAt: string | null
    unitId: number
    unitNum: string
    propertyId: number
    propertyName: string
    tenantId: number | null
    tenantName: string | null
    tenantPhone: string | null
    assignedTo: number | null
    assignedName: string | null
    laborCost: number | null
    materialsCost: number | null
    expenseId: number | null
    history: Array<{ from: string | null; to: string; at: string }>
    notes: MaintenanceNote[]
    attachments: MaintenanceAttachment[]
    assignees: Array<{ id: number; name: string; role: StaffRole }>
}
export interface MaintenanceWorkInput {
    assignedTo?: number | null
    laborCost?: number | null
    materialsCost?: number | null
}
export interface MaintenanceSummary {
    days: number
    byStatus: Record<string, number>
    byPriority: Record<string, number>
    byType: Record<string, number>
    open: number
    averageDaysToComplete: number | null
}
export interface UploadedFile {
    filename: string
    contentType: string
    data: Buffer
    sha256: string
}
export interface StoredFile {
    filename: string
    contentType: string
    data: Buffer
}
export interface TenantPhoto {
    id: number
    filename: string
    href: string
}

/* ---- Documents ---- */
export type DocumentScope = "property" | "unit" | "tenant" | "lease"
export type DocumentCategory = "lease" | "inspection" | "insurance" | "notice" | "receipt" | "other"
export interface HubDocument {
    id: number
    kind: "document" | "lease_pdf" | "receipt"
    scope: DocumentScope
    scopeId: number
    category: DocumentCategory
    title: string
    filename: string
    contentType: string
    sizeBytes: number
    sharedWithTenant: boolean
    uploadedAt: string
    uploadedBy: string | null
    propertyId: number | null
    propertyName: string | null
    unitId: number | null
    unitNum: string | null
    tenantId: number | null
    tenantName: string | null
    leaseId: number | null
    href: string
}
export interface HubFilter {
    scope: DocumentScope | null
    id: number | null
    category: DocumentCategory | null
    q: string | null
}
export interface NewDocument {
    scope: DocumentScope
    scopeId: number
    category: DocumentCategory
    title: string
    sharedWithTenant: boolean
    file: UploadedFile
}
export interface DocumentChange {
    title?: string
    category?: DocumentCategory
    sharedWithTenant?: boolean
}
export interface TenantDocument {
    id: number
    kind: "document" | "lease_pdf"
    title: string
    filename: string
    uploadedAt: string
    href: string
}

/* ---- Notices ---- */
export type NoticeTemplate = "rent_upcoming" | "rent_due" | "rent_overdue" | "payment_received" | "maintenance_update" | "manual" | "invite" | "lease_ending" | "custom"
export interface NoticeRow {
    id: number
    tenantId: number
    tenantName: string
    unitLabel: string | null
    channel: "in_app" | "email"
    template: NoticeTemplate
    subject: string
    body: string
    status: "queued" | "sending" | "sent" | "failed" | "skipped"
    error: string | null
    createdAt: string
    createdBy: string | null
    sentAt: string | null
    readAt: string | null
}
export interface NoticeFilter {
    template: string | null
    channel: string | null
    status: string | null
    q: string | null
}
export type NoticeAudience = { kind: "all" } | { kind: "property"; id: number } | { kind: "tenant"; id: number }
export interface TenantNotice {
    id: number
    template: NoticeTemplate
    subject: string
    body: string
    createdAt: string
    readAt: string | null
}

/* ---- Listings and leads ---- */
export type ListingStatus = "draft" | "active" | "ended"
export interface ListingRow {
    id: number
    unitId: number
    status: ListingStatus
    title: string
    description: string | null
    askingRent: number
    availableOn: string | null
    beds: number | null
    baths: number | null
    sqft: number | null
    amenities: string[]
    pets: string | null
    unitNum: string
    propertyId: number
    propertyName: string
    address: string
    occupied: boolean
    createdAt: string
    createdBy: string | null
    publishedAt: string | null
    endedAt: string | null
    zillowStatus: "not_connected"
    leads: number
    newLeads: number
    photos: number
}
export interface ListingInput {
    title: string
    description: string | null
    askingRent: number
    availableOn: string | null
    beds: number | null
    baths: number | null
    sqft: number | null
    amenities: string[]
    pets: string | null
}
export type LeadStatus = "new" | "contacted" | "closed"
export interface LeadRow {
    id: number
    listingId: number
    name: string
    email: string | null
    phone: string | null
    message: string | null
    source: "manual" | "website" | "zillow"
    status: LeadStatus
    createdAt: string
}
export interface LeadInput {
    name: string
    email: string | null
    phone: string | null
    message: string | null
}
export interface PublicListing {
    id: number
    title: string
    description: string | null
    askingRent: number
    availableOn: string | null
    beds: number | null
    baths: number | null
    sqft: number | null
    amenities: string[]
    pets: string | null
    city: string | null
    photoIds: number[]
}
