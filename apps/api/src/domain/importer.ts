/**
 * Bringing records over from RentRedi and the office's older systems.
 *
 * The client's first priority from the 2026-09-28 meeting: about a year of
 * history for the properties on RentRedi, plus whatever the other properties
 * are kept in. Nobody yet knows what RentRedi's export looks like, so the
 * importer reads three simple CSV layouts (IMPORT_COLUMNS) that any export can
 * be rearranged into in a spreadsheet, and the header names are forgiving.
 *
 * Every import runs as the manager who started it, through the same functions
 * and Row-Level Security as doing the work by hand. Each row gets its own
 * savepoint: one bad row is reported and the rest carry on. A dry run (the
 * default) does all of it and then rolls it all back, so the report shows
 * exactly what a real run would do.
 */

import { createHash } from "node:crypto";
import type { Tx } from "../db/context.ts";
import { PostgresError } from "../db/protocol.ts";
import { parseDate, parseDollars, readTable } from "../../../../packages/shared/src/csv.ts";
import { ENTRY_CATEGORIES, type EntryCategory, type EntryType } from "../../../../packages/shared/src/ledger.ts";
import { periodOf, today } from "../../../../packages/shared/src/ids.ts";
import type {
  ImportReport,
  ImportRequest,
  ImportRowResult,
  IssuedLogin,
  ResidentContact,
} from "../../../../packages/shared/src/portfolio.ts";
import { IMPORT_COLUMNS } from "../../../../packages/shared/src/portfolio.ts";
import * as portfolio from "./portfolio.ts";
import { postEntry } from "./ledger.ts";

const REQUIRED: Record<ImportRequest["kind"], string[]> = {
  units: ["property_name", "unit_label"],
  leases: ["property_name", "unit_label", "resident_name", "email", "lease_start", "monthly_rent"],
  ledger: ["property_name", "unit_label", "date", "type", "amount"],
};

/** Header spellings seen in real exports, mapped to ours. */
const ALIASES: Record<string, string> = {
  property: "property_name",
  property_address: "address_line1",
  address: "address_line1",
  street: "address_line1",
  zip: "postal_code",
  zip_code: "postal_code",
  unit: "unit_label",
  unit_number: "unit_label",
  unit_name: "unit_label",
  beds: "bedrooms",
  baths: "bathrooms",
  rent: "monthly_rent",
  rent_amount: "monthly_rent",
  market_rent_amount: "market_rent",
  tenant_name: "resident_name",
  tenant: "resident_name",
  name: "resident_name",
  tenant_email: "email",
  email_address: "email",
  tenant_phone: "phone",
  phone_number: "phone",
  start_date: "lease_start",
  lease_start_date: "lease_start",
  move_in: "lease_start",
  end_date: "lease_end",
  lease_end_date: "lease_end",
  rent_due_day: "due_day",
  security_deposit: "deposit",
  roommates: "other_residents",
  co_tenants: "other_residents",
  transaction_date: "date",
  posted: "date",
  memo: "description",
  note: "description",
  id: "reference",
  transaction_id: "reference",
};

type Row = Record<string, string>;

class RowError extends Error {}

export async function runImport(
  tx: Tx,
  request: ImportRequest,
  actor: { userId: string; role: string },
): Promise<ImportReport> {
  const table = readTable(request.csv);
  const rows = table.rows.map((r) => ({
    line: r.line,
    values: Object.fromEntries(Object.entries(r.values).map(([k, val]) => [ALIASES[k] ?? k, val])) as Row,
  }));
  const header = new Set(table.header.map((h) => ALIASES[h] ?? h));
  const missing = REQUIRED[request.kind].filter((c) => !header.has(c));

  const report: ImportReport = {
    kind: request.kind,
    dryRun: request.dryRun,
    totals: { create: 0, update: 0, skip: 0, error: 0 },
    rows: [],
    logins: [],
  };

  if (missing.length > 0) {
    report.rows.push({
      row: 1,
      status: "error",
      message: `The file is missing ${missing.length === 1 ? "a column" : "columns"}: ${missing.join(", ")}. Expected: ${IMPORT_COLUMNS[request.kind].join(", ")}.`,
    });
    report.totals.error = 1;
    return report;
  }
  if (rows.length === 0) {
    report.rows.push({ row: 1, status: "error", message: "The file has a header but no rows." });
    report.totals.error = 1;
    return report;
  }

  const source = request.source || "previous system";
  const lookups = new Lookups(tx);
  await tx.query("SAVEPOINT import_all");

  for (const { line, values } of rows) {
    await tx.query("SAVEPOINT import_row");
    let result: ImportRowResult;
    try {
      const outcome =
        request.kind === "units"
          ? await importUnit(tx, lookups, values)
          : request.kind === "leases"
            ? await importLease(tx, lookups, values, report.logins)
            : await importLedgerRow(tx, lookups, values, source, actor);
      result = { row: line, ...outcome };
      await tx.query("RELEASE SAVEPOINT import_row");
    } catch (error) {
      await tx.query("ROLLBACK TO SAVEPOINT import_row");
      await tx.query("RELEASE SAVEPOINT import_row");
      lookups.forget();
      result = { row: line, status: "error", message: explain(error) };
    }
    report.rows.push(result);
    report.totals[result.status] += 1;
  }

  if (request.dryRun) {
    await tx.query("ROLLBACK TO SAVEPOINT import_all");
    // Nothing was created, so no password was issued.
    report.logins = [];
  }
  await tx.query("RELEASE SAVEPOINT import_all");
  return report;
}

function explain(error: unknown): string {
  if (error instanceof RowError || error instanceof portfolio.PortfolioRefused) return error.message;
  if (error instanceof PostgresError) {
    if (/violates|duplicate key|row-level security|permission denied/i.test(error.message)) {
      return "The database refused this row.";
    }
    return error.message.charAt(0).toUpperCase() + error.message.slice(1);
  }
  return error instanceof Error ? error.message : "Could not import this row.";
}

/* ------------------------------------------------------------------ *
 * Lookups, cached for the length of one import
 * ------------------------------------------------------------------ */

class Lookups {
  private properties = new Map<string, string | null>();
  private units = new Map<string, string | null>();
  private readonly tx: Tx;
  constructor(tx: Tx) {
    this.tx = tx;
  }

  /** After a rolled-back row, anything it created is gone again. */
  forget(): void {
    this.properties.clear();
    this.units.clear();
  }

  async property(name: string): Promise<string | null> {
    const key = name.trim().toLowerCase();
    if (!this.properties.has(key)) {
      const row = await this.tx.maybeOne<{ id: string }>(
        "SELECT id FROM properties WHERE lower(name) = $1 ORDER BY created_at LIMIT 1",
        [key],
      );
      this.properties.set(key, row?.id ?? null);
    }
    return this.properties.get(key) ?? null;
  }

  rememberProperty(name: string, id: string): void {
    this.properties.set(name.trim().toLowerCase(), id);
  }

  async unit(propertyId: string, label: string): Promise<string | null> {
    const key = `${propertyId}|${label.trim().toLowerCase()}`;
    if (!this.units.has(key)) {
      const row = await this.tx.maybeOne<{ id: string }>(
        "SELECT id FROM units WHERE property_id = $1 AND lower(label) = $2",
        [propertyId, label.trim().toLowerCase()],
      );
      this.units.set(key, row?.id ?? null);
    }
    return this.units.get(key) ?? null;
  }

  async unitOf(values: Row): Promise<{ propertyId: string; unitId: string }> {
    const propertyId = await this.property(values.property_name ?? "");
    if (!propertyId) throw new RowError(`No property named “${values.property_name}”. Import units first.`);
    const unitId = await this.unit(propertyId, values.unit_label ?? "");
    if (!unitId) throw new RowError(`${values.property_name} has no unit “${values.unit_label}”. Import units first.`);
    return { propertyId, unitId };
  }
}

function required(values: Row, column: string): string {
  const value = (values[column] ?? "").trim();
  if (!value) throw new RowError(`${column} is empty.`);
  return value;
}

function dollars(values: Row, column: string, { optional = false } = {}): number | null {
  const raw = (values[column] ?? "").trim();
  if (!raw) {
    if (optional) return null;
    throw new RowError(`${column} is empty.`);
  }
  const cents = parseDollars(raw);
  if (cents === null) throw new RowError(`${column} “${raw}” is not an amount.`);
  return cents;
}

function dateOf(values: Row, column: string, { optional = false } = {}): string | null {
  const raw = (values[column] ?? "").trim();
  if (!raw) {
    if (optional) return null;
    throw new RowError(`${column} is empty.`);
  }
  const iso = parseDate(raw);
  if (!iso) throw new RowError(`${column} “${raw}” is not a date. Use 2025-10-01 or 10/1/2025.`);
  return iso;
}

/* ------------------------------------------------------------------ *
 * Units (and their properties)
 * ------------------------------------------------------------------ */

async function importUnit(tx: Tx, lookups: Lookups, values: Row): Promise<Omit<ImportRowResult, "row">> {
  const propertyName = required(values, "property_name");
  const label = required(values, "unit_label");
  const bedrooms = values.bedrooms ? Number(values.bedrooms) : null;
  const bathrooms = values.bathrooms ? Number(values.bathrooms) : null;
  if (bedrooms !== null && !(Number.isInteger(bedrooms) && bedrooms >= 0 && bedrooms <= 20)) {
    throw new RowError(`bedrooms “${values.bedrooms}” should be a whole number.`);
  }
  if (bathrooms !== null && !(bathrooms >= 0 && bathrooms <= 20)) {
    throw new RowError(`bathrooms “${values.bathrooms}” is not a number.`);
  }
  // In a units file a plain "Rent" column is the unit's rent, not a lease's.
  if (!values.market_rent && values.monthly_rent) values.market_rent = values.monthly_rent;
  const rent = dollars(values, "market_rent", { optional: true }) ?? 0;
  if (rent < 0) throw new RowError("market_rent cannot be negative.");

  let propertyId = await lookups.property(propertyName);
  let createdProperty = false;
  if (!propertyId) {
    const address = {
      name: propertyName,
      addressLine1: required(values, "address_line1"),
      addressLine2: values.address_line2 ?? "",
      city: required(values, "city"),
      state: required(values, "state"),
      postalCode: required(values, "postal_code"),
    };
    if (!/^[A-Za-z]{2}$/.test(address.state)) throw new RowError(`state “${address.state}” should be a two-letter code.`);
    propertyId = await portfolio.saveProperty(tx, null, address);
    lookups.rememberProperty(propertyName, propertyId);
    createdProperty = true;
  }

  const existing = await lookups.unit(propertyId, label);
  const unit = { propertyId, label, bedrooms, bathrooms, marketRentCents: rent };
  await portfolio.saveUnit(tx, existing, unit);
  if (existing) return { status: "update", message: `Updated unit ${label} at ${propertyName}.` };
  lookups.forget(); // the new unit must be found by the next row
  return {
    status: "create",
    message: createdProperty
      ? `Added property ${propertyName} and unit ${label}.`
      : `Added unit ${label} at ${propertyName}.`,
  };
}

/* ------------------------------------------------------------------ *
 * Leases and residents
 * ------------------------------------------------------------------ */

/** "Sam Rivera <sam@example.com>; Ana Rivera <ana@example.com>" */
function otherResidents(text: string): ResidentContact[] {
  if (!text.trim()) return [];
  return text.split(/[;\n]/).map((part) => part.trim()).filter(Boolean).map((part) => {
    const match = /^(.*?)\s*<\s*([^>\s]+@[^>\s]+)\s*>$/.exec(part);
    if (!match || !match[1]!.trim()) {
      throw new RowError(`other_residents “${part}” should look like Name <email>.`);
    }
    return { name: match[1]!.trim(), email: match[2]!.toLowerCase(), phone: "" };
  });
}

async function importLease(
  tx: Tx,
  lookups: Lookups,
  values: Row,
  logins: IssuedLogin[],
): Promise<Omit<ImportRowResult, "row">> {
  const { unitId } = await lookups.unitOf(values);
  const email = required(values, "email").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new RowError(`email “${email}” is not an email address.`);
  const startsOn = dateOf(values, "lease_start")!;
  const endsOn = dateOf(values, "lease_end", { optional: true });
  if (endsOn && endsOn < startsOn) throw new RowError("lease_end is before lease_start.");
  const rent = dollars(values, "monthly_rent")!;
  if (rent <= 0) throw new RowError("monthly_rent must be more than zero.");
  const dueDay = values.due_day ? Number(values.due_day) : 1;
  if (!(Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 28)) throw new RowError("due_day should be 1 to 28.");
  const deposit = dollars(values, "deposit", { optional: true }) ?? 0;
  const phone = (values.phone ?? "").trim();
  if (phone && !/^[+()\d\s.-]{7,20}$/.test(phone)) throw new RowError(`phone “${phone}” is not a phone number.`);

  const active = await tx.maybeOne<{ id: string; email: string }>(
    `SELECT t.id, u.email FROM tenancies t JOIN users u ON u.id = t.resident_user_id
     WHERE t.unit_id = $1 AND t.status = 'active'`,
    [unitId],
  );
  if (active) {
    if (active.email === email) return { status: "skip", message: `Already on file: ${email} in ${values.unit_label}.` };
    throw new RowError(
      `${values.property_name} ${values.unit_label} already has an active lease (${active.email}). End it first, or import past leases before current ones.`,
    );
  }

  const ended = endsOn !== null && endsOn < today();
  const created = await portfolio.createLease(tx, {
    unitId,
    resident: { name: required(values, "resident_name"), email, phone },
    otherResidents: otherResidents(values.other_residents ?? ""),
    startsOn,
    endsOn,
    monthlyRentCents: rent,
    rentDueDay: dueDay,
    depositCents: deposit,
  });
  if (ended) await portfolio.endLease(tx, created.tenancyId, endsOn!);
  logins.push(...created.logins.filter((l) => l.temporaryPassword !== null));

  const people = created.logins.length;
  return {
    status: "create",
    message: `${ended ? "Past lease" : "Lease"} for ${values.property_name} ${values.unit_label}, ${people} ${people === 1 ? "resident" : "residents"}${ended ? `, ended ${endsOn}` : ""}.`,
  };
}

/* ------------------------------------------------------------------ *
 * Ledger history
 * ------------------------------------------------------------------ */

const TYPE_DEFAULTS: Record<string, { entryType: EntryType; category: EntryCategory; sign: 1 | -1; allowed: EntryCategory[] }> = {
  charge: {
    entryType: "charge", category: "rent", sign: 1,
    allowed: ["rent", "prorated_rent", "utility", "parking", "pet_rent", "late_fee", "nsf_fee", "deposit", "other"],
  },
  payment: {
    entryType: "payment", category: "payment_ach", sign: -1,
    allowed: ["payment_ach", "payment_card", "payment_check", "payment_cash", "payment_money_order", "other"],
  },
  credit: {
    entryType: "credit", category: "concession", sign: -1,
    allowed: ["concession", "maintenance_credit", "waiver", "refund", "other"],
  },
};

/** Words an export might use for a category, mapped to ours. */
const CATEGORY_WORDS: Record<string, EntryCategory> = {
  late_fee: "late_fee", late: "late_fee", fee: "other", utilities: "utility", water: "utility",
  pet: "pet_rent", ach: "payment_ach", bank: "payment_ach", card: "payment_card", check: "payment_check",
  cash: "payment_cash", money_order: "payment_money_order", nsf: "nsf_fee", security_deposit: "deposit",
};

async function importLedgerRow(
  tx: Tx,
  lookups: Lookups,
  values: Row,
  source: string,
  actor: { userId: string; role: string },
): Promise<Omit<ImportRowResult, "row">> {
  const { unitId } = await lookups.unitOf(values);
  const date = dateOf(values, "date")!;
  if (date > today()) throw new RowError(`date ${date} is in the future.`);
  const typeWord = required(values, "type").toLowerCase();
  const kind = TYPE_DEFAULTS[typeWord];
  if (!kind) throw new RowError(`type “${values.type}” should be charge, payment or credit.`);
  const amount = dollars(values, "amount")!;
  if (amount === 0) throw new RowError("amount is zero.");
  const magnitude = Math.abs(amount);

  const categoryWord = (values.category ?? "").trim().toLowerCase().replace(/[^a-z]+/g, "_");
  let category: EntryCategory = kind.category;
  if (categoryWord) {
    const mapped = (ENTRY_CATEGORIES as readonly string[]).includes(categoryWord)
      ? (categoryWord as EntryCategory)
      : CATEGORY_WORDS[categoryWord] ?? "other";
    category = kind.allowed.includes(mapped) ? mapped : "other";
  }

  // The portal posts the current month's rent itself (post-recurring-charges).
  // Importing it too would bill the month twice.
  if (kind.entryType === "charge" && (category === "rent" || category === "prorated_rent") && periodOf(date) === periodOf(today())) {
    return { status: "skip", message: "This month's rent is posted by the portal itself, so it was not imported." };
  }

  // The lease that was running on that date.
  const lease = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM tenancies
     WHERE unit_id = $1 AND starts_on <= $2::date AND (ends_on IS NULL OR ends_on >= $2::date)
     ORDER BY (status = 'active') DESC, starts_on DESC LIMIT 1`,
    [unitId, date],
  );
  if (!lease) {
    throw new RowError(`No lease on ${values.property_name} ${values.unit_label} covers ${date}. Import leases first.`);
  }

  const reference = (values.reference ?? "").trim();
  const fingerprint =
    reference ||
    createHash("sha256")
      .update([date, typeWord, category, magnitude, values.description ?? ""].join("|"))
      .digest("hex")
      .slice(0, 24);
  const key = `import:${lease.id}:${fingerprint}`;
  const already = await tx.maybeOne("SELECT 1 FROM ledger_entries WHERE idempotency_key = $1", [key]);
  if (already) return { status: "skip", message: `Already imported (${reference || "same row"}).` };

  const description =
    (values.description ?? "").trim().slice(0, 450) ||
    (kind.entryType === "charge" ? `Charge (${category.replace(/_/g, " ")})` : kind.entryType === "payment" ? "Payment" : "Credit");
  await postEntry(tx, {
    tenancyId: lease.id,
    entryType: kind.entryType,
    category,
    amountCents: kind.sign * magnitude,
    description,
    period: periodOf(date),
    effectiveDate: date,
    actorUserId: actor.userId,
    actorRole: actor.role,
    actorReason: `Imported from ${source}`.slice(0, 1000),
    idempotencyKey: key,
  });
  return {
    status: "create",
    message: `${kind.entryType === "charge" ? "Charge" : kind.entryType === "payment" ? "Payment" : "Credit"} of $${(magnitude / 100).toFixed(2)} on ${date}.`,
  };
}
