/**
 * Client entry point: the route table, then start.
 *
 * Views are loaded on demand, so a resident signing in never downloads the
 * manager console and vice versa. Each route declares which roles may reach it;
 * that check is a convenience for the person browsing, not a security boundary
 * — the API and the database refuse the data regardless of what the client
 * decides to render.
 */

import { navigate, route, start } from "./core/app.ts";

/* Resident ---------------------------------------------------------- */

route("/", async () => (await import("./views/tenant-overview.ts")).tenantOverview, ["tenant"]);

route("/ledger", async () => (await import("./views/tenant-ledger.ts")).tenantLedger, ["tenant"]);

route("/ledger/:entryId", async () => (await import("./views/tenant-ledger.ts")).tenantEntryTrace, ["tenant"]);

route("/pay", async () => (await import("./views/tenant-pay.ts")).tenantPay, ["tenant"]);

route("/maintenance", async () => (await import("./views/tenant-maintenance.ts")).tenantMaintenance, ["tenant"]);

route("/maintenance/new", async () => (await import("./views/tenant-maintenance.ts")).tenantNewRequest, ["tenant"]);

route(
  "/maintenance/:workOrderId",
  async () => (await import("./views/tenant-maintenance.ts")).tenantRequestDetail,
  ["tenant"],
);

route("/messages", async () => (await import("./views/messages.ts")).messagesInbox, ["tenant"]);

route("/messages/:threadId", async () => (await import("./views/messages.ts")).messagesThread, ["tenant"]);

route("/documents", async () => (await import("./views/tenant-documents.ts")).tenantDocuments, ["tenant"]);

route("/notices", async () => (await import("./views/tenant-maintenance.ts")).tenantNotices, ["tenant"]);

/* Manager, staff, owner --------------------------------------------- */

// The manager workspace from the Figma prototype ("Manger Prototype 2").
route("/manage", async () => (await import("./views/manager-dashboard.ts")).managerDashboard, ["manager", "owner"]);

// Updates: the accounts that need a decision. Called "Exceptions" until
// 2026-09-29; the old address forwards to the new one.
route("/manage/updates", async () => (await import("./views/manager-exceptions.ts")).managerExceptions, ["manager", "owner"]);
route("/manage/exceptions", async () => async () => navigate("/manage/updates", { replace: true }), ["manager", "owner"]);

route("/manage/alerts", async () => (await import("./views/manager-dashboard.ts")).managerAlerts, [
  "manager",
  "owner",
  "staff",
]);

route(
  "/manage/properties",
  async () => (await import("./views/manager-dashboard.ts")).managerProperties,
  ["manager", "owner"],
);

route("/manage/units", async () => (await import("./views/manager-directory.ts")).managerUnits, ["manager", "owner"]);

route("/manage/tenants", async () => (await import("./views/manager-directory.ts")).managerTenants, ["manager", "owner"]);

route("/manage/reports", async () => (await import("./views/manager-directory.ts")).managerReports, ["manager", "owner"]);

route("/manage/settings", async () => (await import("./views/manager-directory.ts")).managerSettings, [
  "manager",
  "owner",
  "staff",
]);

route("/manage/messages", async () => (await import("./views/messages.ts")).messagesInbox, ["manager", "staff"]);

route("/manage/messages/:threadId", async () => (await import("./views/messages.ts")).messagesThread, [
  "manager",
  "staff",
]);

route("/manage/more", async () => (await import("./views/manager-dashboard.ts")).managerMore, [
  "manager",
  "owner",
  "staff",
]);

route(
  "/manage/rent-roll",
  async () => (await import("./views/manager-rentroll.ts")).managerRentRoll,
  ["manager", "owner"],
);

route(
  "/manage/tenancy/:tenancyId",
  async () => (await import("./views/manager-rentroll.ts")).managerTenancy,
  ["manager", "owner"],
);

route(
  "/manage/properties/:propertyId",
  async () => (await import("./views/manager-portfolio.ts")).managerPropertyDetail,
  ["manager", "owner"],
);

route("/manage/import", async () => (await import("./views/manager-portfolio.ts")).managerImport, ["manager"]);

route("/manage/charges", async () => (await import("./views/manager-rentroll.ts")).managerCharges, ["manager"]);

// The one manager-side route on-site staff can reach. Everything financial is
// absent from their navigation and refused by the database if requested anyway.
route(
  "/manage/maintenance",
  async () => (await import("./views/manager-maintenance.ts")).managerMaintenance,
  ["manager", "staff"],
);

route(
  "/manage/maintenance/:workOrderId",
  async () => (await import("./views/manager-maintenance.ts")).managerWorkOrderDetail,
  ["manager", "staff"],
);

route("/manage/access", async () => (await import("./views/manager-maintenance.ts")).managerAccess, ["manager"]);

/* Shared ------------------------------------------------------------ */

// Any signed-in role. Suggested by the RentRedi audit (backlog item 9).
route("/privacy", async () => (await import("./views/privacy.ts")).privacyPage);

route("/sign-in", async () => (await import("./views/sign-in.ts")).signIn);

route("/change-password", async () => (await import("./views/sign-in.ts")).changePassword);
// Also reachable while signed in (a reset link opened in a browser where
// someone is already signed in).
route("/forgot-password", async () => (await import("./views/sign-in.ts")).forgotPassword);
route("/reset-password", async () => (await import("./views/sign-in.ts")).resetPassword);

void start();
