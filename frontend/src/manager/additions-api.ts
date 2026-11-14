// The 009 manager API: team, activity, documents, maintenance detail, portfolios,
// property/tenant details, compliance, reports, notices, listings, leads and search.
// Shapes mirror src/types/additions.ts.
import { apiFetch } from "../api/session";
import { ManagerApiError, type RequestPriority, type RequestStatus, type RequestType } from "./api";

async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await apiFetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ManagerApiError((json as { error?: string }).error ?? "UNKNOWN", res.status);
  return json as T;
}
const query = (params: Record<string, string | number | null | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

/* ------------------------------------------------------------------ Team, activity */

export type StaffRoleKey = "admin" | "maintenance_staff";
export interface TeamMember {
  id: number;
  name: string;
  email: string;
  role: StaffRoleKey;
  status: "active" | "invited" | "deactivated";
  mfaEnabled: boolean;
  lastLoginAt: string | null;
}
export interface SignUpLink {
  inviteLink: string;
  expiresAt: string;
}
export interface ActivityEntry {
  at: string;
  by: string | null;
  byName: string | null;
  kind: "change" | "security";
  table: string | null;
  rowPk: string | null;
  action: string;
  summary: string;
  details: unknown;
}
export interface ActivityFilter {
  kind?: string;
  table?: string;
  since?: string;
  limit?: number;
}
const activityQuery = (f: ActivityFilter) => query({ kind: f.kind, table: f.table, since: f.since, limit: f.limit ?? 200 });

export const teamApi = {
  team: () => call<{ team: TeamMember[] }>("/api/manager/team").then((r) => r.team),
  invite: (input: { name: string; email: string; role: StaffRoleKey }) => call<SignUpLink & { id: number }>("/api/manager/team", "POST", input),
  update: (id: number, change: { name?: string; role?: StaffRoleKey }) => call<{ ok: true }>(`/api/manager/team/${id}`, "PUT", change),
  deactivate: (id: number) => call<{ ok: true }>(`/api/manager/team/${id}`, "DELETE"),
  /** A new sign-up link for someone who hasn't signed up yet. */
  reissue: (id: number) => call<SignUpLink>(`/api/manager/team/${id}/invite`, "POST"),
  /** Forgot their password: the old one stops working and this link sets a new one. */
  resetSignIn: (id: number) => call<SignUpLink>(`/api/manager/team/${id}/reset`, "POST"),
  activity: (f: ActivityFilter) => call<{ entries: ActivityEntry[] }>(`/api/manager/activity${activityQuery(f)}`).then((r) => r.entries),
  activityCsvUrl: (f: ActivityFilter) => `/api/manager/activity.csv${activityQuery({ ...f, limit: f.limit ?? 1000 })}`,
};

/* ------------------------------------------------------------------ Files */

export const DOC_SCOPES: Array<[DocScope, string]> = [
  ["property", "Property"],
  ["unit", "Unit"],
  ["tenant", "Tenant"],
  ["lease", "Lease"],
];
export const DOC_CATEGORIES: Array<[DocCategory, string]> = [
  ["lease", "Lease"],
  ["inspection", "Inspection"],
  ["insurance", "Insurance"],
  ["notice", "Notice"],
  ["receipt", "Receipt"],
  ["other", "Other"],
];
export const DOC_CATEGORY_TEXT = Object.fromEntries(DOC_CATEGORIES) as Record<DocCategory, string>;
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const DOCUMENT_ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";
export const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";

/** A file as { filename, data } (base64). Throws a message to show when it can't be sent. */
export async function readFile(file: File, rules: { accept: string; maxBytes: number }): Promise<{ filename: string; data: string }> {
  if (/\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type)) {
    throw new Error("iPhone HEIC photos can't be stored. On the iPhone, set Camera → Formats → Most Compatible, or upload a screenshot of the photo.");
  }
  if (!rules.accept.split(",").includes(file.type)) throw new Error(rules.accept.includes("pdf") ? "Upload a PDF, or a JPEG, PNG or WebP photo." : "Upload a JPEG, PNG or WebP photo.");
  if (file.size > rules.maxBytes) throw new Error(`That file is over ${Math.round(rules.maxBytes / 1024 / 1024)} MB.`);
  if (file.size === 0) throw new Error("That file is empty.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { filename: file.name, data: btoa(binary) };
}

export function fileSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ Documents, maintenance detail */

export type DocScope = "property" | "unit" | "tenant" | "lease";
export type DocCategory = "lease" | "inspection" | "insurance" | "notice" | "receipt" | "other";
export interface HubDocument {
  id: number;
  kind: "document" | "lease_pdf" | "receipt";
  scope: DocScope;
  scopeId: number;
  category: DocCategory;
  title: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sharedWithTenant: boolean;
  uploadedAt: string;
  uploadedBy: string | null;
  propertyId: number | null;
  propertyName: string | null;
  unitId: number | null;
  unitNum: string | null;
  tenantId: number | null;
  tenantName: string | null;
  leaseId: number | null;
  href: string;
}
export const DOC_KIND_TEXT: Record<HubDocument["kind"], string> = { document: "Uploaded", lease_pdf: "Signed lease", receipt: "Payment receipt" };

export interface MaintenanceDetail {
  id: number;
  title: string;
  description: string;
  status: RequestStatus;
  priority: RequestPriority;
  requestType: RequestType;
  scheduledFor: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  unitId: number;
  unitNum: string;
  propertyId: number;
  propertyName: string;
  tenantId: number | null;
  tenantName: string | null;
  tenantPhone: string | null;
  assignedTo: number | null;
  assignedName: string | null;
  laborCost: number | null;
  materialsCost: number | null;
  expenseId: number | null;
  history: Array<{ from: RequestStatus | null; to: RequestStatus; at: string }>;
  notes: Array<{ id: number; body: string; author: string | null; createdAt: string }>;
  attachments: Array<{ id: number; filename: string; sizeBytes: number; uploadedBy: string | null; fromTenant: boolean; uploadedAt: string }>;
  assignees: Array<{ id: number; name: string; role: StaffRoleKey }>;
}
export interface MaintenanceSummary {
  days: number;
  byStatus: Partial<Record<RequestStatus, number>>;
  byPriority: Partial<Record<RequestPriority, number>>;
  byType: Partial<Record<RequestType, number>>;
  open: number;
  averageDaysToComplete: number | null;
}

export const docsApi = {
  hub: (filter: { scope?: DocScope; id?: number; category?: DocCategory; q?: string } = {}) =>
    call<{ documents: HubDocument[] }>(`/api/manager/documents/all${query({ scope: filter.scope, id: filter.id, category: filter.category, q: filter.q?.trim() })}`).then((r) => r.documents),
  upload: (input: { scope: DocScope; id: number; category: DocCategory; title: string; sharedWithTenant: boolean; filename: string; data: string }) =>
    call<{ id: number }>("/api/manager/documents", "POST", input),
  update: (id: number, change: { title?: string; category?: DocCategory; sharedWithTenant?: boolean }) => call<{ ok: true }>(`/api/manager/documents/${id}`, "PUT", change),
  hide: (id: number) => call<{ ok: true }>(`/api/manager/documents/${id}`, "DELETE"),
  request: (id: number) => call<MaintenanceDetail>(`/api/manager/maintenance/${id}`),
  summary: (days: number) => call<MaintenanceSummary>(`/api/manager/maintenance/summary?days=${days}`),
  updateWork: (id: number, change: { assignedTo?: number | null; laborCost?: number | null; materialsCost?: number | null }) =>
    call<{ ok: true }>(`/api/manager/maintenance/${id}/work`, "PUT", change),
  addNote: (id: number, body: string) => call<{ id: number }>(`/api/manager/maintenance/${id}/notes`, "POST", { body }),
  addPhoto: (id: number, photo: { filename: string; data: string }) => call<{ id: number }>(`/api/manager/maintenance/${id}/attachments`, "POST", photo),
  photoUrl: (id: number, attachmentId: number) => `/api/manager/maintenance/${id}/attachments/${attachmentId}`,
  recordExpense: (id: number) => call<{ expenseId: number }>(`/api/manager/maintenance/${id}/expense`, "POST"),
};

/* ------------------------------------------------------------------ Portfolios, details, compliance, reports */

export interface Portfolio {
  id: number;
  name: string;
  entityName: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  properties: Array<{ id: number; name: string; address: string }>;
  propertyCount: number;
  units: number;
  occupied: number;
  occupancy: number;
  monthlyRent: number;
  outstanding: number;
}
export interface PropertyDetails {
  propertyId: number;
  name: string;
  address: string;
  portfolioId: number | null;
  portfolioName: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  timeZone: string | null;
  notes: string | null;
}
export type InsuranceStatus = "not_required" | "required" | "on_file" | "expired";
export const INSURANCE_STATUSES: Array<[InsuranceStatus, string]> = [
  ["not_required", "Not required"],
  ["required", "Required, not on file"],
  ["on_file", "On file"],
  ["expired", "Expired"],
];
export const INSURANCE_TEXT = Object.fromEntries(INSURANCE_STATUSES) as Record<InsuranceStatus, string>;
export interface TenantDetails {
  tenantId: number;
  notes: string | null;
  insuranceStatus: InsuranceStatus;
  insuranceExpires: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}
export interface ComplianceSettings {
  state: string;
  securityDepositMaxMonths: number | null;
  depositInterestRequired: boolean | null;
  lateFeeGraceDays: number | null;
  lateFeeMaxPercent: number | null;
  noticeToQuitDays: number | null;
  rentIncreaseNoticeDays: number | null;
  leadPaintDisclosureRequired: boolean | null;
  notes: string | null;
  references: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}
export type ComplianceInput = Omit<ComplianceSettings, "confirmedAt" | "confirmedBy" | "updatedAt" | "updatedBy">;
export interface ComplianceWarning {
  code: "deposit_above_max" | "grace_below_min" | "late_fee_above_max";
  message: string;
  unitId: number | null;
}
export interface ReportInfo {
  key: string;
  name: string;
  description: string;
  href: string;
  filters: Array<"from" | "to" | "year">;
}
export const TIME_ZONES: Array<[string, string]> = [
  ["America/New_York", "Eastern (New York)"],
  ["America/Chicago", "Central (Chicago)"],
  ["America/Denver", "Mountain (Denver)"],
  ["America/Phoenix", "Mountain, no DST (Phoenix)"],
  ["America/Los_Angeles", "Pacific (Los Angeles)"],
  ["America/Anchorage", "Alaska"],
  ["Pacific/Honolulu", "Hawaii"],
];

export const officeApi = {
  portfolios: () => call<{ portfolios: Portfolio[]; unassigned: Array<{ id: number; name: string; address: string }> }>("/api/manager/portfolios"),
  createPortfolio: (input: { name: string; entityName: string | null; notes: string | null }) => call<{ id: number }>("/api/manager/portfolios", "POST", input),
  updatePortfolio: (id: number, input: { name: string; entityName: string | null; notes: string | null }) => call<{ id: number }>(`/api/manager/portfolios/${id}`, "PUT", input),
  retirePortfolio: (id: number) => call<{ ok: true }>(`/api/manager/portfolios/${id}`, "DELETE"),
  propertyDetails: (id: number) => call<PropertyDetails>(`/api/manager/properties/${id}/details`),
  savePropertyDetails: (id: number, input: Pick<PropertyDetails, "portfolioId" | "city" | "state" | "zip" | "timeZone" | "notes">) =>
    call<{ ok: true }>(`/api/manager/properties/${id}/details`, "PUT", input),
  tenantDetails: (id: number) => call<TenantDetails>(`/api/manager/tenants/${id}/details`),
  saveTenantDetails: (id: number, input: Omit<TenantDetails, "tenantId" | "updatedAt" | "updatedBy">) => call<{ ok: true }>(`/api/manager/tenants/${id}/details`, "PUT", input),
  compliance: () => call<ComplianceSettings>("/api/manager/compliance"),
  /** `confirm`: also mark the settings as reviewed now. */
  saveCompliance: (input: ComplianceInput, confirm: boolean) => call<{ ok: true }>("/api/manager/compliance", "PUT", { ...input, confirm }),
  warnings: () => call<{ warnings: ComplianceWarning[] }>("/api/manager/compliance/warnings").then((r) => r.warnings),
  reports: () => call<{ reports: ReportInfo[] }>("/api/manager/reports").then((r) => r.reports),
  /** Download a report: the browser saves the CSV under the server's file name. */
  download: async (href: string, params: Record<string, string>) => {
    const res = await apiFetch(`/api/manager${href}${query(params)}`);
    if (!res.ok) throw new ManagerApiError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "UNKNOWN", res.status);
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "report.csv";
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

/* ------------------------------------------------------------------ Notices, listings, leads */

export const NOTICE_TEMPLATES: Record<string, string> = {
  rent_upcoming: "Rent reminder",
  rent_due: "Rent due",
  rent_overdue: "Rent past due",
  payment_received: "Payment received",
  maintenance_update: "Maintenance update",
  manual: "From the office",
  invite: "Invitation",
  lease_ending: "Lease ending",
  custom: "Other",
};
export const NOTICE_STATUSES: Record<string, string> = { queued: "Waiting to send", sending: "Sending", sent: "Sent", failed: "Failed", skipped: "Not sent" };
export const LEAD_STATUSES: Array<[LeadStatus, string]> = [
  ["new", "New"],
  ["contacted", "Contacted"],
  ["closed", "Closed"],
];
export const LEAD_SOURCES: Record<string, string> = { manual: "Entered by the office", website: "Your website", zillow: "Zillow" };
export const LISTING_STATUSES: Record<ListingStatus, string> = { draft: "Draft", active: "Listed", ended: "Ended" };

export interface NoticeRow {
  id: number;
  tenantId: number;
  tenantName: string;
  unitLabel: string | null;
  channel: "in_app" | "email";
  template: string;
  subject: string;
  body: string;
  status: string;
  error: string | null;
  createdAt: string;
  createdBy: string | null;
  sentAt: string | null;
  readAt: string | null;
}
export type NoticeAudience = { kind: "all" } | { kind: "property" | "tenant"; id: number };
export type ListingStatus = "draft" | "active" | "ended";
export type LeadStatus = "new" | "contacted" | "closed";
export interface Listing {
  id: number;
  unitId: number;
  status: ListingStatus;
  title: string;
  description: string | null;
  askingRent: number;
  availableOn: string | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  amenities: string[];
  pets: string | null;
  unitNum: string;
  propertyId: number;
  propertyName: string;
  address: string;
  occupied: boolean;
  createdAt: string;
  createdBy: string | null;
  publishedAt: string | null;
  endedAt: string | null;
  zillowStatus: "not_connected";
  leads: number;
  newLeads: number;
  photos: number;
}
export interface Lead {
  id: number;
  listingId: number;
  name: string;
  email: string | null;
  phone: string | null;
  message: string | null;
  source: "manual" | "website" | "zillow";
  status: LeadStatus;
  createdAt: string;
}
export type ListingInput = Pick<Listing, "title" | "description" | "askingRent" | "availableOn" | "beds" | "baths" | "sqft" | "amenities" | "pets">;
export interface ZillowStatus {
  status: "not_connected";
  label: string;
  detail: string;
}

export const commsApi = {
  notices: (filter: { template?: string; channel?: string; status?: string; q?: string } = {}) =>
    call<{ emailEnabled: boolean; notices: NoticeRow[] }>(`/api/manager/notices${query(filter)}`),
  send: (input: { audience: NoticeAudience; subject: string; body: string; email: boolean }) =>
    call<{ recipients: number; emailsQueued: number; emailsSkipped: number }>("/api/manager/notices", "POST", input),
  listings: () => call<{ listings: Listing[]; zillow: ZillowStatus }>("/api/manager/listings"),
  listing: (id: number) => call<Listing & { leadList: Lead[] }>(`/api/manager/listings/${id}`),
  createListing: (input: ListingInput & { unitId: number }) => call<{ id: number }>("/api/manager/listings", "POST", input),
  updateListing: (id: number, input: ListingInput) => call<{ ok: true }>(`/api/manager/listings/${id}`, "PUT", input),
  publish: (id: number) => call<{ ok: true }>(`/api/manager/listings/${id}/publish`, "POST"),
  end: (id: number) => call<{ ok: true }>(`/api/manager/listings/${id}/end`, "POST"),
  removeDraft: (id: number) => call<{ ok: true }>(`/api/manager/listings/${id}`, "DELETE"),
  leads: () => call<{ leads: Lead[] }>("/api/manager/leads").then((r) => r.leads),
  addLead: (listingId: number, input: { name: string; email: string | null; phone: string | null; message: string | null }) =>
    call<{ id: number }>(`/api/manager/listings/${listingId}/leads`, "POST", input),
  setLeadStatus: (id: number, status: LeadStatus) => call<{ ok: true }>(`/api/manager/leads/${id}`, "PUT", { status }),
};

/* ------------------------------------------------------------------ Search */

export type SearchKind = "tenant" | "unit" | "property" | "portfolio" | "maintenance" | "listing" | "document" | "payment";
export interface SearchHit {
  kind: SearchKind;
  id: number;
  title: string;
  detail: string | null;
  tenantId: number | null;
  unitId: number | null;
  leaseId: number | null;
}
export async function search(q: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const res = await apiFetch(`/api/manager/search?q=${encodeURIComponent(q)}`, { signal });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ManagerApiError((json as { error?: string }).error ?? "UNKNOWN", res.status);
  return (json as { hits: SearchHit[] }).hits;
}
