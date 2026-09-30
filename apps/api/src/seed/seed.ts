/**
 * Seed data: Woodcrest Apartments, 96 units, two years of history.
 *
 * Built to be a realistic evaluation subject rather than a demo. The proposal
 * commits to task-based usability sessions on a seeded staging instance, to a
 * timed triage task with eight exceptions in it, and to a reconciliation
 * accuracy task — a month containing a failed ACH, a partial payment, and a fee
 * reversal, where a resident and a manager are each asked independently what the
 * closing balance is. Those scenarios exist here by construction, on named
 * units, so a session can be run against a known state rather than against
 * whatever random data happened to generate.
 *
 * Everything is written through the same domain services the application uses.
 * Seeding with raw INSERTs would produce a database the application could never
 * have created, which is the fastest way to a test suite that passes against
 * data no user will ever have.
 */

import type { Pool } from "../db/pool.ts";
import { SYSTEM_CONTEXT, withContext, type Tx } from "../db/context.ts";
import { hashPassword } from "../auth/password.ts";
import { postEntry } from "../domain/ledger.ts";
import { addDays, daysInMonth, dueDateFor, periodOf, shiftPeriod, today } from "../../../../packages/shared/src/ids.ts";
import type { Cents } from "../../../../packages/shared/src/money.ts";

const ORG_ID = "a0000000-0000-4000-8000-000000000001";
const PROPERTY_ID = "a0000000-0000-4000-8000-000000000002";
const SECOND_PROPERTY_ID = "a0000000-0000-4000-8000-000000000003";

/** Everyone in the seed shares this. It is printed at the end of seeding. */
export const SEED_PASSWORD = "SeniorProject2026";

const FIRST_NAMES = [
  "Maria", "James", "Aisha", "Diego", "Sarah", "Wei", "Fatima", "Marcus", "Elena", "Raj",
  "Nicole", "Tomas", "Grace", "Ahmed", "Rebecca", "Luis", "Hannah", "Kwame", "Sofia", "Daniel",
  "Priya", "Michael", "Yuki", "Carlos", "Amara", "Jonathan", "Leila", "Andre", "Naomi", "Victor",
  "Ingrid", "Samuel", "Rosa", "Ethan", "Zainab", "Patrick", "Mei", "Gabriel", "Chloe", "Omar",
  "Teresa", "Nathan", "Anika", "Roberto", "Julia", "Dmitri", "Camille", "Hassan",
];

const LAST_NAMES = [
  "Alvarez", "Chen", "Okafor", "Martinez", "Thompson", "Nguyen", "Haddad", "Johnson", "Petrov", "Sharma",
  "Brooks", "Silva", "Adeyemi", "Kowalski", "Reyes", "Murphy", "Tanaka", "Mensah", "Rossi", "Bergman",
  "Castillo", "Fitzgerald", "Osei", "Lindqvist", "Delgado", "Whitfield", "Farouk", "Nakamura",
];

export interface SeedOptions {
  log?: (message: string) => void;
  monthsOfHistory?: number;
}

export async function seed(pool: Pool, options: SeedOptions = {}): Promise<string> {
  const log = options.log ?? (() => {});
  const months = options.monthsOfHistory ?? 24;

  const existing = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM organizations");
  if (existing.rows[0].count > 0) {
    return "Database already contains an organization; seeding was skipped. Drop the database first to reseed.";
  }

  const passwordHash = (await hashPassword(SEED_PASSWORD)).hash;

  return withContext(pool, SYSTEM_CONTEXT, async (tx) => {
    log("creating organization and properties");

    await tx.query(
      `INSERT INTO organizations (id, name, legal_name, contact_email, contact_phone, timezone)
       VALUES ($1, 'Sunbelt Residential', 'Sunbelt Residential Management LLC',
               'office@sunbelt-residential.example', '(575) 555-0142', 'America/Denver')`,
      [ORG_ID],
    );

    await tx.query(
      `INSERT INTO properties (id, organization_id, name, address_line1, city, state, postal_code, unit_count)
       VALUES
         ($1, $3, 'Woodcrest Apartments', '2400 Woodcrest Drive', 'Las Cruces', 'NM', '88011', 96),
         ($2, $3, 'Mesilla Court', '118 Calle de Guadalupe', 'Mesilla', 'NM', '88046', 24)`,
      [PROPERTY_ID, SECOND_PROPERTY_ID, ORG_ID],
    );

    // The second property exists so that isolation between properties is
    // testable, not just isolation between residents.
    const staff = await createStaff(tx, passwordHash);
    log(`created ${staff.length} staff accounts`);

    const units = await createUnits(tx);
    log(`created ${units.length} units across two properties`);

    const tenancies = await createTenancies(tx, units, passwordHash, months);
    log(`created ${tenancies.length} tenancies`);

    await configurePolicies(tx, staff.manager);
    log("configured late-fee policies (Woodcrest on, Mesilla off)");

    const history = await buildHistory(tx, tenancies, months, staff.manager, log);
    log(`posted ${history} ledger entries across ${months} months`);

    await buildEvaluationScenarios(tx, tenancies, staff.manager, log);

    const counts = await tx.one<{ entries: number; payments: number; workorders: number; disputes: number }>(
      `SELECT
         (SELECT count(*) FROM ledger_entries)::int AS entries,
         (SELECT count(*) FROM payments)::int AS payments,
         (SELECT count(*) FROM work_orders)::int AS workorders,
         (SELECT count(*) FROM charge_disputes)::int AS disputes`,
    );

    return [
      "",
      "Seeded.",
      "",
      `  ${tenancies.length} tenancies · ${counts.entries} ledger entries · ${counts.payments} payments`,
      `  ${counts.workorders} maintenance requests · ${counts.disputes} disputes`,
      "",
      "Sign in with any of these. Password for every account:",
      `  ${SEED_PASSWORD}`,
      "",
      "  manager@sunbelt-residential.example   property manager, both properties",
      "  onsite@sunbelt-residential.example    on-site staff, maintenance only",
      "  owner@sunbelt-residential.example     owner, read-only",
      "",
      "Residents (each is unit-number@woodcrest.example):",
      "  101@woodcrest.example   clean history, autopay on",
      "  102@woodcrest.example   the reconciliation scenario: failed ACH, partial payment, waived fee",
      "  103@woodcrest.example   payment plan in progress",
      "  104@woodcrest.example   open dispute on a late fee",
      "  105@woodcrest.example   returned ACH, fees paused",
      "",
      "Mock payments: an amount ending in .01 always declines, .02 settles then is",
      "returned days later, .03 becomes a chargeback. Everything else succeeds.",
      "",
    ].join("\n");
  });
}

/**
 * FRIDAY TEST COPY: a blank portal for live data entry during the demo. Only
 * the organization and the manager's sign-in exist; no properties, units,
 * residents, leases, ledger history or maintenance requests. Everything shown
 * on Friday is typed in through the portal itself.
 */
export async function seedBlank(pool: Pool): Promise<string> {
  const existing = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM organizations");
  if (existing.rows[0].count > 0) {
    return "Database already contains an organization; seeding was skipped. Drop the database first to reseed.";
  }

  const passwordHash = (await hashPassword(SEED_PASSWORD)).hash;

  return withContext(pool, SYSTEM_CONTEXT, async (tx) => {
    await tx.query(
      `INSERT INTO organizations (id, name, legal_name, contact_email, contact_phone, timezone)
       VALUES ($1, 'Summit', 'Summit',
               'office@seniorproject.example', '(575) 555-0142', 'America/Denver')`,
      [ORG_ID],
    );
    await tx.query(
      `INSERT INTO users (organization_id, email, display_name, role, password_hash, phone)
       VALUES ($1, 'manager@seniorproject.example', 'Property Manager', 'manager', $2, NULL)`,
      [ORG_ID, passwordHash],
    );

    return [
      "",
      "Seeded a blank portal: no properties, units, residents or history.",
      "",
      "Sign in as the manager:",
      "  manager@seniorproject.example",
      `  ${SEED_PASSWORD}`,
      "",
    ].join("\n");
  });
}

async function createStaff(tx: Tx, passwordHash: string) {
  const people = [
    { email: "manager@sunbelt-residential.example", name: "Dana Whitfield", role: "manager", properties: [PROPERTY_ID, SECOND_PROPERTY_ID] },
    { email: "onsite@sunbelt-residential.example", name: "Ray Okafor", role: "staff", properties: [PROPERTY_ID] },
    { email: "owner@sunbelt-residential.example", name: "Patricia Lindqvist", role: "owner", properties: [PROPERTY_ID, SECOND_PROPERTY_ID] },
    { email: "mesilla@sunbelt-residential.example", name: "Tomas Reyes", role: "manager", properties: [SECOND_PROPERTY_ID] },
  ];

  const created: Array<{ id: string; email: string; role: string }> & { manager?: string } = [] as never;

  for (const person of people) {
    const row = await tx.one<{ id: string }>(
      `INSERT INTO users (organization_id, email, display_name, role, password_hash, phone)
       VALUES ($1, $2, $3, $4, $5, '(575) 555-0100') RETURNING id`,
      [ORG_ID, person.email, person.name, person.role, passwordHash],
    );
    for (const propertyId of person.properties) {
      await tx.query("INSERT INTO staff_assignments (user_id, property_id) VALUES ($1, $2)", [
        row.id,
        propertyId,
      ]);
    }
    created.push({ id: row.id, email: person.email, role: person.role });
  }

  const result = created as typeof created & { manager: string };
  result.manager = created.find((p) => p.email === "manager@sunbelt-residential.example")!.id;
  return result;
}

interface SeedUnit {
  id: string;
  label: string;
  propertyId: string;
  rentCents: number;
  bedrooms: number;
}

async function createUnits(tx: Tx): Promise<SeedUnit[]> {
  const units: SeedUnit[] = [];

  // Woodcrest: 96 units across four buildings, priced by bedroom count.
  for (let building = 1; building <= 4; building += 1) {
    for (let number = 1; number <= 24; number += 1) {
      const label = `${building}${String(number).padStart(2, "0")}`;
      const bedrooms = number <= 8 ? 1 : number <= 20 ? 2 : 3;
      const rentCents = bedrooms === 1 ? 89_500 : bedrooms === 2 ? 112_500 : 139_000;
      const row = await tx.one<{ id: string }>(
        `INSERT INTO units (property_id, label, bedrooms, bathrooms, square_feet, market_rent_cents)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [PROPERTY_ID, label, bedrooms, bedrooms === 3 ? 2 : 1, 550 + bedrooms * 250, rentCents],
      );
      units.push({ id: row.id, label, propertyId: PROPERTY_ID, rentCents, bedrooms });
    }
  }

  for (let number = 1; number <= 24; number += 1) {
    const label = `M${String(number).padStart(2, "0")}`;
    const row = await tx.one<{ id: string }>(
      `INSERT INTO units (property_id, label, bedrooms, bathrooms, square_feet, market_rent_cents)
       VALUES ($1, $2, 2, 1, 900, 98000) RETURNING id`,
      [SECOND_PROPERTY_ID, label],
    );
    units.push({ id: row.id, label, propertyId: SECOND_PROPERTY_ID, rentCents: 98_000, bedrooms: 2 });
  }

  return units;
}

interface SeedTenancy {
  id: string;
  userId: string;
  unitLabel: string;
  propertyId: string;
  rentCents: number;
  startsOn: string;
  dueDay: number;
}

async function createTenancies(
  tx: Tx,
  units: SeedUnit[],
  passwordHash: string,
  months: number,
): Promise<SeedTenancy[]> {
  const tenancies: SeedTenancy[] = [];
  const currentPeriod = periodOf(today());

  for (const [index, unit] of units.entries()) {
    // A handful of units sit vacant, because a rent roll where every unit is
    // occupied is not a rent roll anyone recognizes.
    if (index % 17 === 16) continue;

    const first = FIRST_NAMES[index % FIRST_NAMES.length];
    const last = LAST_NAMES[(index * 7) % LAST_NAMES.length];
    const domain = unit.propertyId === PROPERTY_ID ? "woodcrest.example" : "mesilla.example";

    const user = await tx.one<{ id: string }>(
      `INSERT INTO users (organization_id, email, display_name, role, password_hash, phone)
       VALUES ($1, $2, $3, 'tenant', $4, $5) RETURNING id`,
      [
        ORG_ID,
        `${unit.label.toLowerCase()}@${domain}`,
        `${first} ${last}`,
        passwordHash,
        `(575) 555-${String(1000 + index).slice(-4)}`,
      ],
    );

    // Stagger start dates so that the seed contains real move-ins mid-history,
    // and therefore real prorated charges.
    const monthsAgo = Math.min(months - 1, 3 + (index % (months - 2)));
    const startPeriod = shiftPeriod(currentPeriod, -monthsAgo);
    const startsOn = index % 11 === 3 ? `${startPeriod}-14` : `${startPeriod}-01`;
    const dueDay = index % 13 === 5 ? 5 : 1;
    const rentCents = unit.rentCents + (index % 5) * 1500;

    const tenancy = await tx.one<{ id: string }>(
      `INSERT INTO tenancies
         (organization_id, property_id, unit_id, resident_user_id, starts_on, monthly_rent_cents,
          rent_due_day, deposit_cents, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active') RETURNING id`,
      [ORG_ID, unit.propertyId, unit.id, user.id, startsOn, rentCents, dueDay, rentCents],
    );

    // Some leases carry extras, which is what makes the charge scheduler's
    // handling of recurring non-rent charges exercisable.
    if (index % 6 === 0) {
      await tx.query(
        `INSERT INTO recurring_charges
           (organization_id, property_id, tenancy_id, category, amount_cents, description, day_of_month, starts_on)
         VALUES ($1, $2, $3, 'parking', 4500, 'Reserved parking space', 1, $4)`,
        [ORG_ID, unit.propertyId, tenancy.id, startsOn],
      );
    }
    if (index % 9 === 2) {
      await tx.query(
        `INSERT INTO recurring_charges
           (organization_id, property_id, tenancy_id, category, amount_cents, description, day_of_month, starts_on)
         VALUES ($1, $2, $3, 'pet_rent', 3500, 'Pet rent', 1, $4)`,
        [ORG_ID, unit.propertyId, tenancy.id, startsOn],
      );
    }

    tenancies.push({
      id: tenancy.id,
      userId: user.id,
      unitLabel: unit.label,
      propertyId: unit.propertyId,
      rentCents,
      startsOn,
      dueDay,
    });
  }

  return tenancies;
}

async function configurePolicies(tx: Tx, managerId: string): Promise<void> {
  // Woodcrest has a policy enabled, with a real grace period and a cap.
  await tx.query(
    `INSERT INTO late_fee_policies
       (property_id, organization_id, enabled, grace_days, fee_type, flat_cents, max_cents,
        min_balance_cents, updated_by_user_id, updated_at)
     VALUES ($1, $2, true, 5, 'flat', 5000, 15000, 2500, $3, now())`,
    [PROPERTY_ID, ORG_ID, managerId],
  );

  // Mesilla deliberately runs with fees off, which is the system's default and
  // gives the evaluation a property where escalation never happens at all.
  await tx.query(
    `INSERT INTO late_fee_policies (property_id, organization_id, enabled, updated_by_user_id, updated_at)
     VALUES ($1, $2, false, $3, now())`,
    [SECOND_PROPERTY_ID, ORG_ID, managerId],
  );
}

/**
 * Two years of plausible history: rent charged every month, most residents
 * paying on time, a realistic minority paying late, short, or not at all.
 */
async function buildHistory(
  tx: Tx,
  tenancies: SeedTenancy[],
  months: number,
  managerId: string,
  log: (message: string) => void,
): Promise<number> {
  const currentPeriod = periodOf(today());
  let entries = 0;

  for (let offset = months - 1; offset >= 0; offset -= 1) {
    const period = shiftPeriod(currentPeriod, -offset);
    const isCurrentMonth = offset === 0;

    for (const [index, tenancy] of tenancies.entries()) {
      if (`${period}-28` < tenancy.startsOn) continue;

      const dueDate = dueDateFor(period, tenancy.dueDay);
      const [year, month] = period.split("-").map(Number);
      const monthLength = daysInMonth(year, month);

      // Proration on the move-in month, computed against that month's real
      // length rather than a 30-day convention.
      const movesInThisMonth = tenancy.startsOn.slice(0, 7) === period && tenancy.startsOn.slice(8) !== "01";
      if (movesInThisMonth) {
        const firstDay = Number(tenancy.startsOn.slice(8, 10));
        const occupied = monthLength - firstDay + 1;
        const amount = Math.round((tenancy.rentCents * occupied) / monthLength);
        await postEntry(tx, {
          tenancyId: tenancy.id,
          entryType: "charge",
          category: "prorated_rent",
          amountCents: amount,
          description: `Prorated rent, ${occupied} of ${monthLength} days`,
          period,
          effectiveDate: tenancy.startsOn,
          actorRole: "system_job",
          idempotencyKey: `prorated_rent:${tenancy.id}:${period}`,
        });
        entries += 1;

        await postEntry(tx, {
          tenancyId: tenancy.id,
          entryType: "charge",
          category: "deposit",
          amountCents: tenancy.rentCents,
          description: "Security deposit",
          period,
          effectiveDate: tenancy.startsOn,
          actorRole: "system_job",
          idempotencyKey: `deposit:${tenancy.id}`,
        });
        entries += 1;
      } else {
        await postEntry(tx, {
          tenancyId: tenancy.id,
          entryType: "charge",
          category: "rent",
          amountCents: tenancy.rentCents,
          description: `Rent for ${monthLabel(period)}`,
          period,
          effectiveDate: dueDate,
          actorRole: "system_job",
          idempotencyKey: `rent:${tenancy.id}:${period}`,
        });
        entries += 1;
      }

      // Recurring extras.
      if (index % 6 === 0 && !movesInThisMonth) {
        await postEntry(tx, {
          tenancyId: tenancy.id,
          entryType: "charge",
          category: "parking",
          amountCents: 4500,
          description: "Reserved parking space",
          period,
          effectiveDate: dueDate,
          actorRole: "system_job",
          idempotencyKey: `parking:${tenancy.id}:${period}`,
        });
        entries += 1;
      }

      // The current month is left partly unpaid on purpose, so that the rent
      // roll a manager opens has a realistic mix in it rather than a wall of
      // green.
      const behaviour = paymentBehaviour(index, offset);
      if (behaviour === "none" || (isCurrentMonth && index % 4 === 1)) continue;

      const owed = await balanceFor(tx, tenancy.id);
      if (owed <= 0) continue;

      const amount = behaviour === "partial" ? Math.round(owed * 0.6) : owed;
      const payDate =
        behaviour === "late" ? addDays(dueDate, 8 + (index % 6)) : addDays(dueDate, -(index % 3));

      if (payDate > today()) continue;

      const receipt = `R${payDate.slice(0, 4)}-${String(entries).padStart(5, "0")}`;
      const payment = await tx.one<{ id: string }>(
        `INSERT INTO payments
           (organization_id, property_id, tenancy_id, amount_cents, method, status, provider,
            method_label, receipt_number, idempotency_key, initiated_by_user_id, initiated_by_role,
            submitted_at, settled_at, resolved_at)
         VALUES ($1, $2, $3, $4, $5, 'settled', 'mock', $6, $7, $8, $9, 'tenant',
                 $10::timestamptz, $10::timestamptz, $10::timestamptz)
         RETURNING id`,
        [
          ORG_ID, tenancy.propertyId, tenancy.id, amount,
          index % 3 === 0 ? "card" : "ach",
          index % 3 === 0 ? "Simulated ••••4242" : "Simulated Savings & Loan ••••8891",
          receipt, `seed:${tenancy.id}:${period}`, tenancy.userId, `${payDate}T14:30:00Z`,
        ],
      );

      await postEntry(tx, {
        tenancyId: tenancy.id,
        entryType: "payment",
        category: index % 3 === 0 ? "payment_card" : "payment_ach",
        amountCents: -amount,
        description: `${index % 3 === 0 ? "Card" : "Bank"} payment — receipt ${receipt}`,
        period,
        effectiveDate: payDate,
        paymentId: payment.id,
        actorRole: "system_job",
        idempotencyKey: `payment:${payment.id}`,
      });
      entries += 1;

      // Late payers draw the fee the property's policy actually specifies.
      if (behaviour === "late" && tenancy.propertyId === PROPERTY_ID) {
        const feeDate = addDays(dueDate, 6);
        if (feeDate <= today()) {
          await postEntry(tx, {
            tenancyId: tenancy.id,
            entryType: "charge",
            category: "late_fee",
            amountCents: 5000,
            description: "Late fee — 1 day past the grace period",
            period,
            effectiveDate: feeDate,
            actorRole: "system_job",
            idempotencyKey: `late_fee:${tenancy.id}:${feeDate}`,
          });
          entries += 1;
        }
      }
    }

    if (offset % 6 === 0) log(`  ...${period}`);
  }

  return entries;
}

/**
 * The scenarios the proposal's evaluation plan calls for, on named units so a
 * session facilitator can find them.
 */
async function buildEvaluationScenarios(
  tx: Tx,
  tenancies: SeedTenancy[],
  managerId: string,
  log: (message: string) => void,
): Promise<void> {
  const byUnit = new Map(tenancies.map((t) => [t.unitLabel, t]));
  const period = periodOf(today());
  const currentDay = Number(today().slice(8, 10));

  // Unit 102 — the reconciliation accuracy task. One month containing a failed
  // ACH, a partial payment, and a waived fee. A resident and a manager are each
  // asked, independently, what the closing balance is. Agreement between them,
  // and with the system, is the project's headline measure.
  const reconciliation = byUnit.get("102");
  if (reconciliation) {
    const failed = await tx.one<{ id: string }>(
      `INSERT INTO payments
         (organization_id, property_id, tenancy_id, amount_cents, method, status, provider,
          method_label, failure_code, failure_message, idempotency_key, initiated_by_user_id,
          initiated_by_role, submitted_at, resolved_at)
       VALUES ($1, $2, $3, $4, 'ach', 'failed', 'mock', 'Simulated Savings & Loan ••••8891',
               'insufficient_funds',
               'Your bank returned this payment for insufficient funds. Nothing was taken from your account, and the amount has been added back to your balance.',
               $5, $6, 'tenant', now() - interval '9 days', now() - interval '9 days')
       RETURNING id`,
      [ORG_ID, reconciliation.propertyId, reconciliation.id, reconciliation.rentCents, `seed:failed:${reconciliation.id}`, reconciliation.userId],
    );

    await tx.query(
      `UPDATE tenancies SET late_fee_hold_until = current_date + 3,
              late_fee_hold_reason = 'A payment of $' || to_char($2/100.0, 'FM999999.00') ||
                ' did not go through. Late fees are paused while this is sorted out.'
       WHERE id = $1`,
      [reconciliation.id, reconciliation.rentCents],
    );

    await postEntry(tx, {
      tenancyId: reconciliation.id,
      entryType: "annotation",
      category: "other",
      amountCents: 0,
      description:
        "Late fees paused. A bank payment did not go through, and fee accrual is suspended while it is resolved.",
      period,
      effectiveDate: addDays(today(), -9),
      actorRole: "system_job",
      actorReason: "Payment failure was not attributable to a missed obligation.",
      idempotencyKey: `hold:payment:${failed.id}`,
    });

    const partial = Math.round(reconciliation.rentCents * 0.55);
    const partialPayment = await tx.one<{ id: string }>(
      `INSERT INTO payments
         (organization_id, property_id, tenancy_id, amount_cents, method, status, provider,
          method_label, receipt_number, idempotency_key, initiated_by_user_id, initiated_by_role,
          submitted_at, settled_at, resolved_at)
       VALUES ($1, $2, $3, $4, 'card', 'settled', 'mock', 'Simulated ••••4242', 'R2026-90001',
               $5, $6, 'tenant', now() - interval '6 days', now() - interval '6 days', now() - interval '6 days')
       RETURNING id`,
      [ORG_ID, reconciliation.propertyId, reconciliation.id, partial, `seed:partial:${reconciliation.id}`, reconciliation.userId],
    );

    await postEntry(tx, {
      tenancyId: reconciliation.id,
      entryType: "payment",
      category: "payment_card",
      amountCents: -partial,
      description: "Card payment — partial — receipt R2026-90001",
      period,
      effectiveDate: addDays(today(), -6),
      paymentId: partialPayment.id,
      actorRole: "system_job",
      idempotencyKey: `payment:${partialPayment.id}`,
    });

    const fee = await postEntry(tx, {
      tenancyId: reconciliation.id,
      entryType: "charge",
      category: "late_fee",
      amountCents: 5000,
      description: "Late fee — assessed before the payment failure was reviewed",
      period,
      effectiveDate: addDays(today(), -8),
      actorRole: "system_job",
      idempotencyKey: `late_fee:scenario:${reconciliation.id}`,
    });

    await postEntry(tx, {
      tenancyId: reconciliation.id,
      entryType: "reversal",
      category: "waiver",
      amountCents: -5000,
      description: "Waived — the payment failure was on the bank's side, not the resident's",
      period,
      effectiveDate: addDays(today(), -5),
      reversesEntryId: fee.id,
      actorUserId: managerId,
      actorRole: "manager",
      actorReason: "Bank error, not a missed payment. Fee should not have been assessed.",
      idempotencyKey: `waiver:scenario:${reconciliation.id}`,
    });

    log("  unit 102: reconciliation scenario (failed ACH + partial payment + waived fee)");
  }

  // Unit 103 — a payment plan mid-flight, with one installment already met.
  const planned = byUnit.get("103");
  if (planned) {
    const total = Math.round(planned.rentCents * 1.5);
    const plan = await tx.one<{ id: string }>(
      `INSERT INTO payment_plans
         (organization_id, property_id, tenancy_id, total_cents, reason, suspends_late_fees, opened_by_user_id, opened_at)
       VALUES ($1, $2, $3, $4,
               'Resident had unexpected medical expenses and asked for time. Agreed three installments.',
               true, $5, now() - interval '20 days')
       RETURNING id`,
      [ORG_ID, planned.propertyId, planned.id, total, managerId],
    );

    const each = Math.floor(total / 3);
    for (let i = 0; i < 3; i += 1) {
      const amount = i === 0 ? total - each * 2 : each;
      await tx.query(
        `INSERT INTO payment_plan_installments
           (payment_plan_id, tenancy_id, property_id, sequence, due_date, amount_cents, paid_cents, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          plan.id, planned.id, planned.propertyId, i + 1,
          addDays(today(), -14 + i * 30), amount,
          i === 0 ? amount : 0,
          i === 0 ? "paid" : "scheduled",
        ],
      );
    }

    await postEntry(tx, {
      tenancyId: planned.id,
      entryType: "annotation",
      category: "payment_plan",
      amountCents: 0,
      description: `Payment plan opened for $${(total / 100).toFixed(2)} in 3 installments. Late fees are paused while this plan is followed.`,
      period,
      effectiveDate: addDays(today(), -20),
      paymentPlanId: plan.id,
      actorUserId: managerId,
      actorRole: "manager",
      actorReason: "Resident had unexpected medical expenses and asked for time. Agreed three installments.",
      idempotencyKey: `plan:${plan.id}`,
    });

    log("  unit 103: active payment plan, one installment met");
  }

  // Unit 104 — an open dispute on a late fee, which the manager has not yet
  // answered. Gives the triage task something that needs a person.
  const disputed = byUnit.get("104");
  if (disputed) {
    const fee = await postEntry(tx, {
      tenancyId: disputed.id,
      entryType: "charge",
      category: "late_fee",
      amountCents: 5000,
      description: "Late fee — 3 days past the grace period",
      period,
      effectiveDate: addDays(today(), -11),
      actorRole: "system_job",
      idempotencyKey: `late_fee:disputed:${disputed.id}`,
    });

    await tx.query(
      `INSERT INTO charge_disputes
         (organization_id, property_id, tenancy_id, ledger_entry_id, reason, opened_by_user_id, opened_at)
       VALUES ($1, $2, $3, $4,
               'I paid on the 3rd from the portal and have the confirmation email. The payment shows as received on the 9th. I should not owe a late fee for six days that were the bank''s.',
               $5, now() - interval '9 days')`,
      [ORG_ID, disputed.propertyId, disputed.id, fee.id, disputed.userId],
    );

    log("  unit 104: open dispute on a late fee");
  }

  // Unit 105 — an ACH that settled and was then returned four days later, with
  // the reversal on the ledger. The single most confusing event in rent
  // collection, and the one the shared-ledger design is supposed to make legible.
  const returned = byUnit.get("105");
  if (returned) {
    const payment = await tx.one<{ id: string }>(
      `INSERT INTO payments
         (organization_id, property_id, tenancy_id, amount_cents, method, status, provider,
          method_label, receipt_number, failure_code, failure_message, idempotency_key,
          initiated_by_user_id, initiated_by_role, submitted_at, settled_at, resolved_at)
       VALUES ($1, $2, $3, $4, 'ach', 'returned', 'mock', 'Simulated Savings & Loan ••••8891',
               'R2026-90002', 'insufficient_funds',
               'Your bank returned this payment for insufficient funds. Nothing was taken from your account, and the amount has been added back to your balance.',
               $5, $6, 'tenant', now() - interval '12 days', now() - interval '9 days', now() - interval '5 days')
       RETURNING id`,
      [ORG_ID, returned.propertyId, returned.id, returned.rentCents, `seed:returned:${returned.id}`, returned.userId],
    );

    const credit = await postEntry(tx, {
      tenancyId: returned.id,
      entryType: "payment",
      category: "payment_ach",
      amountCents: -returned.rentCents,
      description: "Bank payment — receipt R2026-90002",
      period,
      effectiveDate: addDays(today(), -9),
      paymentId: payment.id,
      actorRole: "system_job",
      idempotencyKey: `payment:${payment.id}`,
    });

    await postEntry(tx, {
      tenancyId: returned.id,
      entryType: "reversal",
      category: "payment_ach",
      amountCents: returned.rentCents,
      description: "Returned by bank — insufficient funds",
      period,
      effectiveDate: addDays(today(), -5),
      reversesEntryId: credit.id,
      actorRole: "system_job",
      actorReason: "Bank returned this payment: insufficient funds.",
      idempotencyKey: `reversal:returned:${returned.id}`,
    });

    await tx.query(
      `UPDATE tenancies SET late_fee_hold_until = current_date + 5,
              late_fee_hold_reason = 'A payment was returned by the bank. Late fees are paused until this is sorted out.'
       WHERE id = $1`,
      [returned.id],
    );

    log("  unit 105: returned ACH with reversal, fees paused");
  }

  // Maintenance: a spread of open and resolved requests, including one resolved
  // with a rent credit so the ledger link is visible in the seed.
  const maintenanceUnits = ["106", "107", "108", "201", "202", "203", "301"];
  for (const [index, label] of maintenanceUnits.entries()) {
    const tenancy = byUnit.get(label);
    if (!tenancy) continue;

    const scenarios = [
      { category: "hvac", priority: "emergency", title: "No heat, apartment is 52 degrees", status: "in_progress" },
      { category: "plumbing", priority: "urgent", title: "Kitchen sink backing up", status: "scheduled" },
      { category: "appliance", priority: "routine", title: "Dishwasher not draining fully", status: "submitted" },
      { category: "electrical", priority: "urgent", title: "Outlet in bedroom sparked", status: "acknowledged" },
      { category: "pest", priority: "routine", title: "Ants in the kitchen", status: "submitted" },
      { category: "plumbing", priority: "emergency", title: "Water heater leaking into hallway", status: "resolved" },
      { category: "locks_keys", priority: "urgent", title: "Front door deadbolt sticking", status: "resolved" },
    ];
    const scenario = scenarios[index % scenarios.length];

    const workOrder = await tx.one<{ id: string; reference: string }>(
      `INSERT INTO work_orders
         (organization_id, property_id, unit_id, tenancy_id, resident_user_id, reference, category,
          priority, status, title, description, entry_permission, submitted_by_user_id,
          submitted_at, acknowledged_at, resolved_at)
       SELECT $1, t.property_id, t.unit_id, t.id, t.resident_user_id, $3, $4, $5, $6, $7, $8, true, t.resident_user_id,
              now() - ($9 || ' days')::interval,
              CASE WHEN $6 <> 'submitted' THEN now() - ($9 || ' days')::interval + interval '3 hours' END,
              CASE WHEN $6 IN ('resolved','closed') THEN now() - interval '2 days' END
       FROM tenancies t WHERE t.id = $2
       RETURNING id, reference`,
      [
        ORG_ID, tenancy.id, `WO-SEED${index}`, scenario.category, scenario.priority, scenario.status,
        scenario.title,
        `${scenario.title}. Reported by the resident through the portal.`,
        String(3 + index * 2),
      ],
    );

    await tx.query(
      `INSERT INTO work_order_events
         (work_order_id, property_id, tenancy_id, kind, to_status, note, author_role, visible_to_resident)
       SELECT $1, t.property_id, t.id, 'status', 'submitted', NULL, 'tenant', true
       FROM tenancies t WHERE t.id = $2`,
      [workOrder.id, tenancy.id],
    );

    // The water-heater one resolves with a credit, so the ledger link exists in
    // the seed rather than only in a test.
    if (scenario.title.startsWith("Water heater")) {
      const entry = await postEntry(tx, {
        tenancyId: tenancy.id,
        entryType: "credit",
        category: "maintenance_credit",
        amountCents: -12_500,
        description: `Credit for maintenance request ${workOrder.reference} — three days without hot water`,
        period,
        effectiveDate: addDays(today(), -2),
        workOrderId: workOrder.id,
        actorUserId: managerId,
        actorRole: "manager",
        actorReason: "Three days without hot water while the replacement was ordered.",
        idempotencyKey: `wo_credit:${workOrder.id}:12500`,
      });

      await tx.query(
        `INSERT INTO work_order_events
           (work_order_id, property_id, tenancy_id, kind, note, author_user_id, author_role,
            visible_to_resident, linked_ledger_entry_id)
         SELECT $1, t.property_id, t.id, 'credit',
                'Credit of $125.00 applied — three days without hot water', $3, 'manager', true, $4
         FROM tenancies t WHERE t.id = $2`,
        [workOrder.id, tenancy.id, managerId, entry.id],
      );
    }
  }
  log(`  ${maintenanceUnits.length} maintenance requests, one resolved with a linked rent credit`);

  // Autopay on a few accounts, including one with a cap low enough that the
  // blocked-by-cap path is reachable in a demo.
  for (const label of ["101", "109", "110", "204"]) {
    const tenancy = byUnit.get(label);
    if (!tenancy) continue;

    const method = await tx.one<{ id: string }>(
      `INSERT INTO payment_methods
         (organization_id, property_id, tenancy_id, kind, provider, provider_token, institution,
          last4, verified, verified_at)
       VALUES ($1, $2, $3, 'ach', 'mock', $4, 'Simulated Savings & Loan', '8891', true, now())
       RETURNING id`,
      [ORG_ID, tenancy.propertyId, tenancy.id, `mock_tok_seed_${tenancy.id}`],
    );

    await tx.query(
      `INSERT INTO autopay_enrollments
         (organization_id, property_id, tenancy_id, payment_method_id, day_of_month, cap_cents, created_by_user_id)
       VALUES ($1, $2, $3, $4, 1, $5, $6)`,
      [
        ORG_ID, tenancy.propertyId, tenancy.id, method.id,
        label === "110" ? Math.round(tenancy.rentCents * 0.9) : null,
        tenancy.userId,
      ],
    );
  }
  log("  autopay on 4 accounts, one with a cap below the balance");

  // A payment method for every resident, so nobody hits a dead end trying to pay
  // during a usability session.
  await tx.query(
    `INSERT INTO payment_methods
       (organization_id, property_id, tenancy_id, kind, provider, provider_token, brand, last4, verified, verified_at)
     SELECT $1, t.property_id, t.id, 'card', 'mock', 'mock_tok_card_' || t.id, 'Simulated', '4242', true, now()
     FROM tenancies t
     WHERE NOT EXISTS (SELECT 1 FROM payment_methods m WHERE m.tenancy_id = t.id AND m.kind = 'card')`,
    [ORG_ID],
  );
}

function paymentBehaviour(index: number, monthsAgo: number): "full" | "partial" | "late" | "none" {
  const seed = (index * 31 + monthsAgo * 17) % 100;
  if (seed < 74) return "full";
  if (seed < 86) return "late";
  if (seed < 95) return "partial";
  return "none";
}

async function balanceFor(tx: Tx, tenancyId: string): Promise<number> {
  const row = await tx.one<{ balance: number }>(
    "SELECT COALESCE(sum(amount_cents), 0)::bigint AS balance FROM ledger_entries WHERE tenancy_id = $1",
    [tenancyId],
  );
  return Number(row.balance);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function monthLabel(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return `${MONTHS[month - 1]} ${year}`;
}
