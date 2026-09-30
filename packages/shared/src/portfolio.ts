/**
 * Portfolio administration, lease residents, lease late-fee terms, lease
 * documents and data import. Added after the client meeting of 2026-09-28
 * (docs/MEETING-2026-09-28.md).
 */

import * as v from "./validate.ts";
import type { Cents } from "./money.ts";
import type { Uuid } from "./ids.ts";

const trimmed = (max: number) =>
  v.string().transform((s) => s.trim()).refine((s) => s.length > 0, "required").refine((s) => s.length <= max, `at most ${max} characters`);
const optionalText = (max: number) =>
  v.string().transform((s) => s.trim()).refine((s) => s.length <= max, `at most ${max} characters`).default("");
const money = () => v.integer().refine((n) => n >= 0, "must not be negative").refine((n) => n <= 100_000_00, "too large");
const phone = () =>
  v.string()
    .transform((s) => s.trim())
    .refine((s) => s === "" || /^[+()\d\s.-]{7,20}$/.test(s), "enter a phone number, like (575) 555-0100")
    
    .default("");

/* ------------------------------------------------------------------ *
 * Properties and units
 * ------------------------------------------------------------------ */

export const savePropertyRequest = v.object({
  name: trimmed(120),
  addressLine1: trimmed(200),
  addressLine2: optionalText(200),
  city: trimmed(80),
  state: trimmed(2).refine((s) => /^[A-Za-z]{2}$/.test(s), "use the two-letter state code"),
  postalCode: trimmed(10).refine((s) => /^\d{5}(-\d{4})?$/.test(s), "use a ZIP code like 88001"),
});
export type SavePropertyRequest = v.Infer<typeof savePropertyRequest>;

export const saveUnitRequest = v.object({
  propertyId: v.uuid().optional(),
  label: trimmed(20),
  bedrooms: v.integer().refine((n) => n >= 0 && n <= 20, "0 to 20").nullable().default(null),
  bathrooms: v.number().refine((n) => n >= 0 && n <= 20, "0 to 20").nullable().default(null),
  marketRentCents: money().default(0),
});
export type SaveUnitRequest = v.Infer<typeof saveUnitRequest>;

/* ------------------------------------------------------------------ *
 * Residents and leases
 * ------------------------------------------------------------------ */

/** Everything the portal keeps about a person. No SSN, no date of birth. */
export const residentContact = v.object({
  name: trimmed(120),
  email: v.email(),
  phone: phone(),
});
export type ResidentContact = v.Infer<typeof residentContact>;

export const createLeaseRequest = v.object({
  unitId: v.uuid(),
  resident: residentContact,
  /** Roommates and co-signers living there, each with their own login. */
  otherResidents: v.array(residentContact).refine((list) => list.length <= 5, "at most 5 more residents").default([]),
  startsOn: v.isoDate(),
  endsOn: v.isoDate().nullable().default(null),
  monthlyRentCents: money().refine((n) => n > 0, "enter the monthly rent"),
  rentDueDay: v.integer().refine((n) => n >= 1 && n <= 28, "pick a day from 1 to 28").default(1),
  depositCents: money().default(0),
});
export type CreateLeaseRequest = v.Infer<typeof createLeaseRequest>;

export const updateLeaseRequest = v.object({
  endsOn: v.isoDate().nullable().default(null),
  monthlyRentCents: money().refine((n) => n > 0, "enter the monthly rent"),
  rentDueDay: v.integer().refine((n) => n >= 1 && n <= 28, "pick a day from 1 to 28"),
  depositCents: money().default(0),
});
export type UpdateLeaseRequest = v.Infer<typeof updateLeaseRequest>;

export const endLeaseRequest = v.object({ endsOn: v.isoDate() });

/** Shown once, to the manager, to hand to the resident. Never stored in clear. */
export interface IssuedLogin {
  userId: Uuid;
  name: string;
  email: string;
  /** Null when the person already had an account; their password is unchanged. */
  temporaryPassword: string | null;
}

export interface LeaseResident {
  userId: Uuid;
  name: string;
  email: string;
  phone: string | null;
  isPrimary: boolean;
  addedAt: string | null;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
}

/* ------------------------------------------------------------------ *
 * Late-fee terms on one lease
 * ------------------------------------------------------------------ */

export const leaseLateFeeRequest = v.object({
  enabled: v.boolean(),
  graceDays: v.integer().refine((n) => n >= 0 && n <= 30, "grace is 0 to 30 days"),
  feeType: v.enumOf(["flat", "percent"] as const),
  flatCents: money().default(0),
  percent: v.number().refine((n) => n >= 0 && n <= 25, "percent must be 0 to 25").default(0),
  dailyCents: money().default(0),
  maxCents: money().default(0),
  minBalanceCents: money().default(0),
  note: optionalText(200),
});
export type LeaseLateFeeRequest = v.Infer<typeof leaseLateFeeRequest>;

export interface LateFeeTerms {
  enabled: boolean;
  graceDays: number;
  feeType: "flat" | "percent";
  flatCents: Cents;
  percent: number;
  dailyCents: Cents;
  maxCents: Cents;
  minBalanceCents: Cents;
  note: string | null;
}

/* ------------------------------------------------------------------ *
 * Lease documents
 * ------------------------------------------------------------------ */

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

export interface LeaseDocumentSignature {
  userId: Uuid;
  name: string;
  typedName: string;
  signedAt: string;
}

export interface LeaseDocument {
  id: Uuid;
  tenancyId: Uuid;
  title: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  requiresSignature: boolean;
  uploadedAt: string;
  uploadedByName: string | null;
  withdrawnAt: string | null;
  signatures: LeaseDocumentSignature[];
  /** Residents on the lease who still need to sign, by name. */
  awaitingSignatureFrom: string[];
  /** For a resident: whether they have signed it themselves. */
  signedByMe?: boolean;
}

export const signDocumentRequest = v.object({
  typedName: trimmed(120).refine((s) => s.length >= 2, "type your full name"),
  /** The hash the resident's screen was showing, so a swapped file cannot be signed blind. */
  sha256: v.string().refine((s) => /^[0-9a-f]{64}$/.test(s), "reload the document and try again"),
  agree: v.literal(true),
});

/* ------------------------------------------------------------------ *
 * Settings: applicant screening
 * ------------------------------------------------------------------ */

export const screeningSettingsRequest = v.object({
  provider: optionalText(80),
  url: v.string()
    .transform((s) => s.trim())
    .refine((s) => s === "" || /^https:\/\/\S+$/.test(s), "use a full https:// link")
    
    .default(""),
});

export interface ScreeningSettings {
  provider: string | null;
  url: string | null;
}

/* ------------------------------------------------------------------ *
 * Data import
 * ------------------------------------------------------------------ */

export const IMPORT_KINDS = ["units", "leases", "ledger"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const importRequest = v.object({
  kind: v.enumOf(IMPORT_KINDS),
  csv: v.string().refine((s) => s.length > 0, "choose a CSV file").refine((s) => s.length <= 900_000, "that file is too large; split it"),
  /** Check everything and report, changing nothing. The default. */
  dryRun: v.boolean().default(true),
  /** Where the records came from, recorded on every imported ledger row. */
  source: optionalText(60),
});
export type ImportRequest = v.Infer<typeof importRequest>;

export interface ImportRowResult {
  row: number;
  status: "create" | "update" | "skip" | "error";
  message: string;
}

export interface ImportReport {
  kind: ImportKind;
  dryRun: boolean;
  totals: { create: number; update: number; skip: number; error: number };
  rows: ImportRowResult[];
  /** Logins created by a leases import, shown once. */
  logins: IssuedLogin[];
}

/** The columns each import expects, in order. Also the template files. */
export const IMPORT_COLUMNS: Record<ImportKind, readonly string[]> = {
  units: ["property_name", "address_line1", "city", "state", "postal_code", "unit_label", "bedrooms", "bathrooms", "market_rent"],
  leases: [
    "property_name", "unit_label", "resident_name", "email", "phone", "lease_start", "lease_end",
    "monthly_rent", "due_day", "deposit", "other_residents",
  ],
  ledger: ["property_name", "unit_label", "date", "type", "category", "description", "amount", "reference"],
};

export const IMPORT_HELP: Record<ImportKind, string> = {
  units:
    "One row per unit. A property is created the first time its name appears. Rent is in dollars, like 950 or 950.00.",
  leases:
    "One row per lease, for units that already exist. other_residents lists roommates as Name <email>; Name <email>. Each person gets a login with a temporary password, shown once after importing.",
  ledger:
    "Account history for leases that already exist: type is charge, payment or credit; amount is in dollars and always positive. Rows are matched by reference (or by their content), so importing the same file twice adds nothing. This month's rent is skipped: the portal posts it.",
};

/* ------------------------------------------------------------------ *
 * Recurring monthly charges on a lease (parking, pet rent, utilities)
 * ------------------------------------------------------------------ */

export const RECURRING_CATEGORIES = ["parking", "pet_rent", "utility", "other"] as const;
export const RECURRING_CATEGORY_LABELS: Record<(typeof RECURRING_CATEGORIES)[number], string> = {
  parking: "Parking",
  pet_rent: "Pet rent",
  utility: "Utility",
  other: "Other",
};

export const recurringChargeRequest = v.object({
  category: v.enumOf(RECURRING_CATEGORIES),
  amountCents: money().refine((n) => n > 0, "enter an amount"),
  description: trimmed(200),
  dayOfMonth: v.integer().refine((n) => n >= 1 && n <= 28, "pick a day from 1 to 28").default(1),
  startsOn: v.isoDate(),
  endsOn: v.isoDate().nullable().default(null),
});
export type RecurringChargeRequest = v.Infer<typeof recurringChargeRequest>;

export interface RecurringCharge {
  id: Uuid;
  category: string;
  amountCents: Cents;
  description: string;
  dayOfMonth: number;
  startsOn: string;
  endsOn: string | null;
  active: boolean;
}
