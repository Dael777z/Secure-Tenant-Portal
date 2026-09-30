/**
 * Roles and the capability matrix.
 *
 * This table is the human-readable statement of the same policy the database
 * enforces in `007_rls.sql`. It exists so that the permission model is legible
 * to a manager delegating access, which the proposal treats as a usability
 * requirement rather than only a security one: if a manager cannot verify for
 * themselves that an on-site agent cannot read owner financials, the model has
 * failed regardless of whether the database is correct.
 *
 * The application checks these capabilities at the route boundary. Row-Level
 * Security in PostgreSQL independently enforces which *rows* each role reaches.
 * A bug in this file is a bug in convenience; it is not a way past isolation.
 */

export const ROLES = ["tenant", "staff", "manager", "owner"] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  "ledger:read:own",
  "ledger:read:property",
  "ledger:write:discretionary",
  "payment:submit:own",
  "payment:method:manage:own",
  "autopay:manage:own",
  "dispute:open:own",
  "dispute:respond",
  "workorder:submit:own",
  "workorder:read:own",
  "workorder:read:property",
  "workorder:triage",
  "rentroll:read",
  "export:generate",
  "charges:post",
  "staff:manage",
  "policy:configure",
  // Added after the 2026-09-28 client meeting.
  "portfolio:manage",
  "documents:manage",
  "documents:sign:own",
  "data:import",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const TENANT: Capability[] = [
  "ledger:read:own",
  "payment:submit:own",
  "payment:method:manage:own",
  "autopay:manage:own",
  "dispute:open:own",
  "workorder:submit:own",
  "workorder:read:own",
  "documents:sign:own",
];

/**
 * On-site staff triage maintenance and see nothing financial. This is the
 * delegation case the proposal names: a leasing agent should close work orders
 * without gaining access to the rent roll.
 */
const STAFF: Capability[] = ["workorder:read:property", "workorder:triage"];

const MANAGER: Capability[] = [
  "ledger:read:property",
  "ledger:write:discretionary",
  "dispute:respond",
  "workorder:read:property",
  "workorder:triage",
  "rentroll:read",
  "export:generate",
  "charges:post",
  "staff:manage",
  "policy:configure",
  "portfolio:manage",
  "documents:manage",
  "data:import",
];

/** Owners read the financial position of their own properties and change nothing. */
const OWNER: Capability[] = ["ledger:read:property", "rentroll:read", "export:generate"];

export const CAPABILITIES_BY_ROLE: Record<Role, readonly Capability[]> = {
  tenant: TENANT,
  staff: STAFF,
  manager: MANAGER,
  owner: OWNER,
};

export function can(role: Role, capability: Capability): boolean {
  return CAPABILITIES_BY_ROLE[role].includes(capability);
}

export const ROLE_LABELS: Record<Role, string> = {
  tenant: "Resident",
  staff: "On-site staff",
  manager: "Property manager",
  owner: "Owner (read-only)",
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  tenant: "Sees their own ledger, pays rent, files maintenance requests, disputes a charge.",
  staff: "Triages maintenance for assigned properties. Cannot read any ledger, payment, or rent-roll data.",
  manager: "Full access to every property in the portfolio, including discretionary actions that append to the ledger.",
  owner: "Reads the rent roll and ledger for their properties. Cannot post, waive, adjust, or triage.",
};
