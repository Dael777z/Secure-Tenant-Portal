/**
 * Setting up the portfolio from the portal, after the 2026-09-28 meeting:
 *
 *   /manage/properties/:id   one property: its address, its units, start a lease
 *   /manage/import           bring records over from RentRedi or a spreadsheet
 *
 * plus the dialogs (property, unit, new lease, new logins) and the sections the
 * lease page shows: who is on the lease, its terms, its late-fee terms, and its
 * documents.
 */

import { closeDialog, h, openDialog, render, type Child } from "../core/dom.ts";
import { ApiError, portfolio, type PropertyDetail, type PropertyPhoto, manager } from "../core/api.ts";
import { can, navigate, reportError, toast } from "../core/app.ts";
import { compactMoney, date, dateTime, money, parseAmount } from "../core/fmt.ts";
import { pill, wsButton, wsHeader, type Tone } from "../core/workspace.ts";
import { IMPORT_COLUMNS, IMPORT_HELP, IMPORT_KINDS, type ImportKind, type ImportReport, type IssuedLogin, type LeaseDocument, type ResidentContact } from "/shared/portfolio.js";

/* ------------------------------------------------------------------ *
 * Small form helpers
 * ------------------------------------------------------------------ */

let fieldSeq = 0;

function input(attrs: Record<string, unknown> = {}): HTMLInputElement {
  fieldSeq += 1;
  return h("input", { class: "input", id: `pf-${fieldSeq}`, ...attrs }) as HTMLInputElement;
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h(
    "label",
    { class: "field", for: control.id },
    h("span", { class: "field__label" }, label),
    control,
    hint ? h("span", { class: "field__hint" }, hint) : null,
  );
}

const dollars = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : (cents / 100).toFixed(2));

/** Parse a dollar field, or throw a message naming it. */
function cents(el: HTMLInputElement, label: string, { required = false } = {}): number {
  if (!el.value.trim()) {
    if (required) throw new FormError(`Enter the ${label.toLowerCase()}.`);
    return 0;
  }
  const value = parseAmount(el.value);
  if (value === null) throw new FormError(`${label} must be dollars, like 950 or 950.00.`);
  return value;
}

class FormError extends Error {}

/**
 * A dialog with a form. `submit` does the work and returns true to close;
 * whatever it throws is shown in the dialog, in the words the API used.
 */
function formDialog(options: {
  title: string;
  intro?: Child;
  body: Child[];
  submitLabel: string;
  submit: () => Promise<boolean | void>;
  wide?: boolean;
}): HTMLDialogElement {
  const error = h("p", { class: "field__error", hidden: true, role: "alert" });
  const submit = h("button", { class: "ws-btn ws-btn--primary", type: "submit" }, options.submitLabel) as HTMLButtonElement;
  const dialog = h(
    "dialog",
    { class: ["dialog", options.wide && "dialog--wide"] },
    h(
      "form",
      {
        method: "dialog",
        onSubmit: async (event: SubmitEvent) => {
          event.preventDefault();
          error.hidden = true;
          submit.disabled = true;
          try {
            const close = await options.submit();
            if (close !== false) closeDialog(dialog);
          } catch (caught) {
            error.textContent =
              caught instanceof FormError || caught instanceof ApiError
                ? caught.message
                : "That did not work. Nothing was changed.";
            if (caught instanceof ApiError && caught.issues.length) {
              error.textContent = caught.issues.map((i) => `${i.path.replace(/^\./, "")}: ${i.message}`).join(" · ");
            }
            error.hidden = false;
            if (!(caught instanceof FormError) && !(caught instanceof ApiError)) console.error(caught);
          } finally {
            submit.disabled = false;
          }
        },
      },
      h("div", { class: "dialog__header" }, h("h2", { class: "dialog__title" }, options.title)),
      h("div", { class: "dialog__body" }, options.intro ? h("p", { class: "field__hint" }, options.intro) : null, ...options.body, error),
      h(
        "div",
        { class: "dialog__footer" },
        h("button", { class: "ws-btn ws-btn--ghost", type: "button", onClick: () => closeDialog(dialog) }, "Cancel"),
        submit,
      ),
    ),
  ) as HTMLDialogElement;
  document.body.appendChild(dialog);
  openDialog(dialog);
  return dialog;
}

/* ------------------------------------------------------------------ *
 * New logins, shown once
 * ------------------------------------------------------------------ */

/**
 * Temporary passwords are shown here and nowhere else: they are not stored in
 * clear, not emailed, and not in the audit log. The manager hands them over
 * (in person, or by phone) and the resident sets their own at first sign-in.
 */
export function showLogins(logins: IssuedLogin[], heading = "Logins to hand over"): void {
  const fresh = logins.filter((l) => l.temporaryPassword);
  if (fresh.length === 0) {
    if (logins.length) toast("Everyone on this lease already had a login; their passwords are unchanged.", "good");
    return;
  }
  const text = fresh.map((l) => `${l.name} — ${l.email} — temporary password: ${l.temporaryPassword}`).join("\n");
  const dialog = h(
    "dialog",
    { class: "dialog dialog--wide" },
    h("div", { class: "dialog__header" }, h("h2", { class: "dialog__title" }, heading)),
    h(
      "div",
      { class: "dialog__body" },
      h(
        "p",
        { class: "field__hint" },
        "Give each person their temporary password in person or by phone. It is shown only now. They choose their own password the first time they sign in. ",
        "The portal never emails passwords.",
      ),
      h(
        "table",
        { class: "ws-table ws-table--plain ws-logins" },
        h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Sign-in email"), h("th", {}, "Temporary password"))),
        h(
          "tbody",
          {},
          ...fresh.map((l) =>
            h("tr", {}, h("td", {}, l.name), h("td", {}, l.email), h("td", {}, h("code", { class: "ws-code" }, l.temporaryPassword!))),
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "dialog__footer" },
      h(
        "button",
        {
          class: "ws-btn ws-btn--ghost",
          type: "button",
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(text);
              toast("Copied.", "good");
            } catch {
              toast("Copying is blocked here; select the text instead.", "info");
            }
          },
        },
        "Copy all",
      ),
      h("button", { class: "ws-btn ws-btn--primary", type: "button", onClick: () => closeDialog(dialog) }, "Done"),
    ),
  ) as HTMLDialogElement;
  document.body.appendChild(dialog);
  openDialog(dialog);
}

/* ------------------------------------------------------------------ *
 * Property and unit dialogs
 * ------------------------------------------------------------------ */

export function openPropertyDialog(existing?: PropertyDetail): void {
  const name = input({ required: true, maxlength: "120", value: existing?.name ?? "", placeholder: "Mesa Vista" });
  const line1 = input({ required: true, maxlength: "200", value: existing?.addressLine1 ?? "", autocomplete: "address-line1" });
  const line2 = input({ maxlength: "200", value: existing?.addressLine2 ?? "", autocomplete: "address-line2" });
  const city = input({ required: true, maxlength: "80", value: existing?.city ?? "Las Cruces", autocomplete: "address-level2" });
  const st = input({ required: true, maxlength: "2", value: existing?.state ?? "NM", autocomplete: "address-level1", style: "text-transform:uppercase" });
  const zip = input({ required: true, maxlength: "10", value: existing?.postalCode ?? "", inputmode: "numeric", autocomplete: "postal-code" });

  formDialog({
    title: existing ? "Edit property" : "Add a property",
    intro: existing ? undefined : "A property is an address. Add its units next; each unit can then have a lease.",
    body: [
      field("Name", name, "What the office calls it."),
      field("Street address", line1),
      field("Address line 2", line2),
      h("div", { class: "ws-form-row" }, field("City", city), field("State", st), field("ZIP", zip)),
    ],
    submitLabel: existing ? "Save property" : "Add property",
    submit: async () => {
      const body = {
        name: name.value, addressLine1: line1.value, addressLine2: line2.value,
        city: city.value, state: st.value.toUpperCase(), postalCode: zip.value,
      };
      if (existing) {
        await portfolio.updateProperty(existing.id, body);
        toast("Property saved.", "good");
        navigate(location.pathname + location.search, { replace: true });
      } else {
        const result = await portfolio.createProperty(body);
        toast(`${body.name} added. Now add its units.`, "good");
        navigate(`/manage/properties/${result.propertyId}`);
      }
    },
  });
}

export async function openUnitDialog(
  options: { propertyId?: string; unit?: PropertyDetail["units"][number] } = {},
): Promise<void> {
  let propertySelect: HTMLSelectElement | null = null;
  if (!options.propertyId && !options.unit) {
    const { properties } = await manager.properties();
    if (properties.length === 0) {
      toast("Add a property first.", "info");
      openPropertyDialog();
      return;
    }
    fieldSeq += 1;
    propertySelect = h(
      "select",
      { class: "select", id: `pf-${fieldSeq}`, required: true },
      ...properties.map((p) => h("option", { value: p.id }, p.name)),
    ) as HTMLSelectElement;
  }
  const unit = options.unit;
  const label = input({ required: true, maxlength: "20", value: unit?.label ?? "", placeholder: "1A" });
  const beds = input({ type: "number", min: "0", max: "20", value: unit?.bedrooms ?? "" });
  const baths = input({ type: "number", min: "0", max: "20", step: "0.5", value: unit?.bathrooms ?? "" });
  const rent = input({ inputmode: "decimal", value: dollars(unit?.marketRentCents ?? null), placeholder: "950.00" });

  formDialog({
    title: unit ? `Edit unit ${unit.label}` : "Add a unit",
    body: [
      propertySelect ? field("Property", propertySelect) : null,
      field("Unit label", label, "As it appears on the door and the lease, like 1A or 102."),
      h("div", { class: "ws-form-row" }, field("Bedrooms", beds), field("Bathrooms", baths)),
      field("Market rent ($ per month)", rent, "What the unit rents for when vacant. Each lease sets its own rent."),
    ],
    submitLabel: unit ? "Save unit" : "Add unit",
    submit: async () => {
      const body = {
        propertyId: options.propertyId ?? propertySelect?.value,
        label: label.value,
        bedrooms: beds.value === "" ? null : Number(beds.value),
        bathrooms: baths.value === "" ? null : Number(baths.value),
        marketRentCents: cents(rent, "Market rent"),
      };
      if (unit) await portfolio.updateUnit(unit.id, body);
      else await portfolio.createUnit(body);
      toast(unit ? "Unit saved." : `Unit ${body.label} added.`, "good");
      navigate(location.pathname + location.search, { replace: true });
    },
  });
}

/* ------------------------------------------------------------------ *
 * Starting a lease
 * ------------------------------------------------------------------ */

function personFields(person?: Partial<ResidentContact>) {
  const name = input({ required: true, maxlength: "120", value: person?.name ?? "", autocomplete: "off" });
  const email = input({ required: true, type: "email", maxlength: "254", value: person?.email ?? "", autocomplete: "off" });
  const phone = input({ type: "tel", maxlength: "20", value: person?.phone ?? "", autocomplete: "off" });
  return {
    name, email, phone,
    value: (): ResidentContact => ({ name: name.value.trim(), email: email.value.trim(), phone: phone.value.trim() }),
    fields: [field("Full name", name), h("div", { class: "ws-form-row" }, field("Email", email, "Their sign-in."), field("Phone", phone))],
  };
}

export async function openLeaseDialog(unit: { id: string; label: string; marketRentCents: number; propertyName: string }): Promise<void> {
  const screening = await portfolio.screening().then((r) => r.screening).catch(() => ({ provider: null, url: null }));
  const primary = personFields();
  const others: Array<ReturnType<typeof personFields>> = [];
  const othersHost = h("div", { class: "ws-stack" });
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  const starts = input({ type: "date", required: true, value: iso });
  const ends = input({ type: "date" });
  const known = unit.marketRentCents > 0 ? dollars(unit.marketRentCents) : "";
  const rent = input({ required: true, inputmode: "decimal", value: known, placeholder: "950.00" });
  const dueDay = input({ type: "number", min: "1", max: "28", value: "1", required: true });
  const deposit = input({ inputmode: "decimal", value: known });

  const addPerson = () => {
    if (others.length >= 5) return;
    const person = personFields();
    others.push(person);
    const block = h(
      "fieldset",
      { class: "ws-fieldset" },
      h("legend", {}, `Resident ${others.length + 1}`),
      ...person.fields,
      h(
        "button",
        {
          class: "ws-btn ws-btn--ghost",
          type: "button",
          onClick: () => {
            others.splice(others.indexOf(person), 1);
            block.remove();
          },
        },
        "Remove",
      ),
    );
    othersHost.appendChild(block);
    person.name.focus();
  };

  formDialog({
    title: `New lease — ${unit.propertyName} ${unit.label}`,
    wide: true,
    intro: screening.url
      ? h(
          "span",
          {},
          "Screen applicants first with ",
          h("a", { href: screening.url, target: "_blank", rel: "noopener noreferrer" }, screening.provider || "your screening provider"),
          ". The portal never asks for or stores Social Security numbers.",
        )
      : "Screen applicants first with your screening provider (you can link it under Settings). The portal never asks for or stores Social Security numbers.",
    body: [
      h("fieldset", { class: "ws-fieldset" }, h("legend", {}, "Primary resident (the lease is filed under them)"), ...primary.fields),
      othersHost,
      h("div", {}, wsButton("+ Add another resident on this lease", { style: "ghost", onClick: addPerson })),
      h(
        "fieldset",
        { class: "ws-fieldset" },
        h("legend", {}, "Terms"),
        h("div", { class: "ws-form-row" }, field("Starts", starts), field("Ends", ends, "Blank for month to month.")),
        h(
          "div",
          { class: "ws-form-row" },
          field("Monthly rent ($)", rent),
          field("Rent due on day", dueDay, "1 to 28."),
          field("Deposit ($)", deposit),
        ),
      ),
    ],
    submitLabel: "Start lease",
    submit: async () => {
      const result = await portfolio.createLease({
        unitId: unit.id,
        resident: primary.value(),
        otherResidents: others.map((o) => o.value()),
        startsOn: starts.value,
        endsOn: ends.value || null,
        monthlyRentCents: cents(rent, "Monthly rent", { required: true }),
        rentDueDay: Number(dueDay.value),
        depositCents: cents(deposit, "Deposit"),
      });
      toast("Lease started.", "good");
      navigate(`/manage/tenancy/${result.tenancyId}`);
      showLogins(result.logins);
    },
  });
}

/* ------------------------------------------------------------------ *
 * /manage/properties/:propertyId
 * ------------------------------------------------------------------ */

export async function managerPropertyDetail(mount: HTMLElement, params: Record<string, string>): Promise<void> {
  const { property } = await portfolio.property(params.propertyId);
  const admin = can("portfolio:manage");
  const occupied = property.units.filter((u) => u.tenancyId).length;
  const address = [property.addressLine1, property.addressLine2, `${property.city}, ${property.state} ${property.postalCode}`]
    .filter(Boolean)
    .join(", ");

  render(
    mount,
    h("a", { class: "ws-back", href: "/manage/properties", onClick: (e: MouseEvent) => { e.preventDefault(); navigate("/manage/properties"); } }, "← Properties"),
    wsHeader(
      property.name,
      `${address} · ${property.units.length} units, ${occupied} occupied`,
      h(
        "div",
        { class: "ws-toolbar" },
        wsButton("Rent roll", { style: "secondary", href: `/manage/rent-roll?propertyId=${property.id}` }),
        admin ? wsButton("Edit property", { style: "secondary", onClick: () => openPropertyDialog(property) }) : null,
        admin ? wsButton("+ Add Unit", { onClick: () => void openUnitDialog({ propertyId: property.id }) }) : null,
      ),
    ),
    h(
      "section",
      { class: "ws-panel", "aria-labelledby": "property-photos" },
      h("h2", { class: "ws-h3", id: "property-photos" }, "Photos of the property"),
      photoGallery(property.id),
    ),
    h(
      "section",
      { class: "ws-panel ws-panel--rows" },
      property.units.length === 0
        ? h("p", { class: "ws-empty" }, admin ? "No units yet. Add the first one." : "No units yet.")
        : h(
            "div",
            { class: "ws-table-wrap" },
            h(
              "table",
              { class: "ws-table ws-table--plain" },
              h("caption", { class: "visually-hidden" }, `Units at ${property.name}`),
              h(
                "thead",
                {},
                h(
                  "tr",
                  {},
                  h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Photo")),
                  h("th", { scope: "col" }, "Unit"),
                  h("th", { scope: "col" }, "Beds / baths"),
                  h("th", { scope: "col" }, "Market rent"),
                  h("th", { scope: "col" }, "Resident"),
                  h("th", { scope: "col" }, h("span", { class: "visually-hidden" }, "Actions")),
                ),
              ),
              h(
                "tbody",
                {},
                ...property.units.map((unit) =>
                  h(
                    "tr",
                    {},
                    h(
                      "td",
                      { class: "photo-cell" },
                      h(
                        "button",
                        {
                          type: "button",
                          class: "photo-cell__button",
                          title: admin ? `Photos of unit ${unit.label}` : undefined,
                          "aria-label": `Photos of unit ${unit.label}`,
                          onClick: () => openUnitPhotosDialog(property.id, { id: unit.id, label: unit.label }),
                        },
                        photoThumb(unit.coverPhotoId, `Unit ${unit.label}`),
                      ),
                    ),
                    h("td", {}, unit.label),
                    h("td", {}, `${unit.bedrooms ?? "—"} / ${unit.bathrooms ?? "—"}`),
                    h("td", { class: "ws-money" }, compactMoney(unit.marketRentCents)),
                    h("td", {}, unit.tenancyId ? unit.residentName ?? "—" : pill("Vacant", "warning")),
                    h(
                      "td",
                      { class: "ws-row-actions" },
                      unit.tenancyId
                        ? wsButton("Open lease", { style: "ghost", href: `/manage/tenancy/${unit.tenancyId}` })
                        : admin
                          ? wsButton("Start lease", {
                              style: "ghost",
                              onClick: () =>
                                void openLeaseDialog({ id: unit.id, label: unit.label, marketRentCents: unit.marketRentCents, propertyName: property.name }).catch(reportError),
                            })
                          : null,
                      wsButton("Photos", { style: "ghost", onClick: () => openUnitPhotosDialog(property.id, { id: unit.id, label: unit.label }) }),
                      admin ? wsButton("Edit", { style: "ghost", onClick: () => void openUnitDialog({ propertyId: property.id, unit }) }) : null,
                    ),
                  ),
                ),
              ),
            ),
          ),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * The lease page: people, terms, late fees, documents
 * ------------------------------------------------------------------ */

type TenancyData = Awaited<ReturnType<typeof manager.tenancy>>;

/** Sections added to /manage/tenancy/:id. Loads what it needs itself. */
export function leaseSections(data: TenancyData, tenancyId: string): HTMLElement[] {
  const active = (data.tenancy as Record<string, unknown>).status === "active";
  return [
    residentsCard(tenancyId),
    termsCard(data, tenancyId),
    recurringCard(tenancyId, active),
    lateFeeCard(data, tenancyId),
    documentsCard(tenancyId),
  ];
}

function residentsCard(tenancyId: string): HTMLElement {
  const admin = can("portfolio:manage");
  const body = h("div", { "aria-live": "polite" }, h("p", { class: "field__hint" }, "Loading…"));
  const load = async () => {
    try {
      const { residents } = await portfolio.residents(tenancyId);
      render(
        body,
        h(
          "ul",
          { class: "lease-people" },
          ...residents.map((r) =>
            h(
              "li",
              { class: "lease-people__item" },
              h(
                "div",
                {},
                h("strong", {}, r.name),
                r.isPrimary ? h("span", { class: "lease-people__tag" }, "Primary") : null,
                h("div", { class: "field__hint" }, [r.email, r.phone].filter(Boolean).join(" · ")),
                h(
                  "div",
                  { class: "field__hint" },
                  r.lastLoginAt ? `Last signed in ${dateTime(r.lastLoginAt)}` : "Has not signed in yet",
                  r.mustChangePassword ? " · still on a temporary password" : "",
                ),
              ),
              admin
                ? h(
                    "div",
                    { class: "row" },
                    h("button", { class: "btn btn--quiet", type: "button", onClick: () => editPerson(r) }, "Edit"),
                    h(
                      "button",
                      {
                        class: "btn btn--quiet",
                        type: "button",
                        onClick: async () => {
                          try {
                            const { temporaryPassword } = await portfolio.resetPassword(r.userId);
                            showLogins([{ userId: r.userId, name: r.name, email: r.email, temporaryPassword }], "New temporary password");
                            void load();
                          } catch (caught) {
                            reportError(caught);
                          }
                        },
                      },
                      "New password",
                    ),
                    r.isPrimary ? null : removeButton(r.userId, r.name),
                  )
                : null,
            ),
          ),
        ),
      );
    } catch (caught) {
      render(body, h("p", { class: "field__error" }, caught instanceof ApiError ? caught.message : "Could not load the residents."));
    }
  };

  const editPerson = (r: { userId: string; name: string; email: string; phone: string | null }) => {
    const person = personFields({ name: r.name, email: r.email, phone: r.phone ?? "" });
    formDialog({
      title: `Edit ${r.name}`,
      intro: "Changing the email changes what they sign in with.",
      body: person.fields,
      submitLabel: "Save",
      submit: async () => {
        await portfolio.updateResident(r.userId, person.value());
        toast("Contact details saved.", "good");
        void load();
      },
    });
  };

  const removeButton = (userId: string, name: string) => {
    let armed = false;
    const button = h(
      "button",
      {
        class: "btn btn--quiet",
        type: "button",
        onClick: async () => {
          if (!armed) {
            armed = true;
            button.textContent = `Remove ${name.split(" ")[0]}?`;
            setTimeout(() => {
              armed = false;
              button.textContent = "Take off lease";
            }, 4000);
            return;
          }
          try {
            await portfolio.removeResident(tenancyId, userId);
            toast(`${name} is no longer on this lease.`, "good");
            void load();
          } catch (caught) {
            reportError(caught);
          }
        },
      },
      "Take off lease",
    );
    return button;
  };

  void load();
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "card__header" },
      h("h2", { class: "card__title" }, "Residents on this lease"),
      admin
        ? h(
            "button",
            {
              class: "btn btn--ghost",
              type: "button",
              onClick: () => {
                const person = personFields();
                formDialog({
                  title: "Add a resident to this lease",
                  intro: "A roommate or co-tenant living in the unit. They get their own login, see the shared account, and can pay part of the rent from their own bank.",
                  body: person.fields,
                  submitLabel: "Add resident",
                  submit: async () => {
                    const { login } = await portfolio.addResident(tenancyId, person.value());
                    void load();
                    showLogins([login]);
                  },
                });
              },
            },
            "+ Add resident",
          )
        : null,
    ),
    body,
  );
}

function termsCard(data: TenancyData, tenancyId: string): HTMLElement {
  const t = data.tenancy as Record<string, string | number | null>;
  const admin = can("portfolio:manage") && t.status === "active";
  const edit = () => {
    const ends = input({ type: "date", value: t.ends_on ?? "" });
    const rent = input({ inputmode: "decimal", required: true, value: dollars(Number(t.monthly_rent_cents)) });
    const due = input({ type: "number", min: "1", max: "28", required: true, value: t.rent_due_day ?? 1 });
    const deposit = input({ inputmode: "decimal", value: dollars(Number(t.deposit_cents ?? 0)) });
    formDialog({
      title: "Change lease terms",
      intro: "Applies from the next charge. Charges already on the ledger stay as they are; correct those with a waiver or an adjustment.",
      body: [field("Ends", ends, "Blank for month to month."), h("div", { class: "ws-form-row" }, field("Monthly rent ($)", rent), field("Due on day", due), field("Deposit ($)", deposit))],
      submitLabel: "Save terms",
      submit: async () => {
        await portfolio.updateLease(tenancyId, {
          endsOn: ends.value || null,
          monthlyRentCents: cents(rent, "Monthly rent", { required: true }),
          rentDueDay: Number(due.value),
          depositCents: cents(deposit, "Deposit"),
        });
        toast("Lease terms saved.", "good");
        navigate(location.pathname, { replace: true });
      },
    });
  };
  const end = () => {
    const today = new Date();
    const on = input({ type: "date", required: true, value: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}` });
    formDialog({
      title: "End this lease",
      intro: "The unit becomes vacant, autopay stops, and everyone on the lease loses access to it. The ledger stays: anything still owed is still owed.",
      body: [field("Last day of the lease", on)],
      submitLabel: "End lease",
      submit: async () => {
        await portfolio.endLease(tenancyId, on.value);
        toast("Lease ended.", "good");
        navigate(location.pathname, { replace: true });
      },
    });
  };
  const fact = (label: string, value: string) => h("div", { class: "facts__row" }, h("dt", {}, label), h("dd", {}, value));
  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "card__header" },
      h("h2", { class: "card__title" }, "Lease terms"),
      admin
        ? h("div", { class: "row" }, h("button", { class: "btn btn--ghost", type: "button", onClick: edit }, "Change terms"), h("button", { class: "btn btn--quiet", type: "button", onClick: end }, "End lease"))
        : null,
    ),
    h(
      "dl",
      { class: "facts" },
      fact("Status", String(t.status ?? "")),
      fact("Starts", date(String(t.starts_on))),
      fact("Ends", t.ends_on ? date(String(t.ends_on)) : "Month to month"),
      fact("Monthly rent", money(Number(t.monthly_rent_cents))),
      fact("Due", `Day ${t.rent_due_day} of each month`),
      fact("Deposit", money(Number(t.deposit_cents ?? 0))),
    ),
  );
}

function lateFeeCard(data: TenancyData, tenancyId: string): HTMLElement {
  const own = data.leaseLateFee;
  const base = own ?? data.propertyLateFee;
  const editable = can("policy:configure");
  const summary = h("p", { class: "field__hint", "aria-live": "polite" }, data.lateFeePolicy);
  const source = h("p", { class: "field__hint" }, own ? `This lease has its own terms${own.note ? ` (${own.note})` : ""}.` : "This lease follows its property's policy.");

  const form = () => {
    const enabled = h("input", { type: "checkbox", checked: base?.enabled ?? true }) as HTMLInputElement;
    const grace = input({ type: "number", min: "0", max: "30", value: base?.graceDays ?? 5 });
    fieldSeq += 1;
    const type = h(
      "select",
      { class: "select", id: `pf-${fieldSeq}` },
      h("option", { value: "flat", selected: (base?.feeType ?? "flat") === "flat" }, "Flat amount"),
      h("option", { value: "percent", selected: base?.feeType === "percent" }, "Percent of balance"),
    ) as HTMLSelectElement;
    const flat = input({ inputmode: "decimal", value: dollars(base?.flatCents ?? 5000) });
    const pct = input({ type: "number", step: "0.5", min: "0", max: "25", value: base?.percent ?? 0 });
    const max = input({ inputmode: "decimal", value: dollars(base?.maxCents ?? 0) });
    const note = input({ maxlength: "200", value: own?.note ?? "", placeholder: "e.g. Commercial lease, section 4(b)" });
    formDialog({
      title: "Late-fee terms for this lease",
      intro: "Fees are applied automatically once the grace period ends. 0 days charges as soon as rent is late (some commercial leases). Any fee applied can still be waived from the ledger.",
      body: [
        h("label", { class: "checkbox" }, enabled, h("span", {}, "Charge late fees on this lease")),
        h("div", { class: "ws-form-row" }, field("Grace period (days)", grace), field("Fee type", type)),
        h("div", { class: "ws-form-row" }, field("Flat fee ($)", flat), field("Percent", pct), field("Most per month ($)", max, "0 for no cap.")),
        field("Why this lease differs", note),
      ],
      submitLabel: "Save terms",
      submit: async () => {
        const result = await portfolio.setLateFee(tenancyId, {
          enabled: enabled.checked,
          graceDays: Number(grace.value),
          feeType: type.value,
          flatCents: cents(flat, "Flat fee"),
          percent: Number(pct.value || 0),
          dailyCents: base?.dailyCents ?? 0,
          maxCents: cents(max, "Most per month"),
          minBalanceCents: base?.minBalanceCents ?? 0,
          note: note.value,
        });
        summary.textContent = result.plainLanguage;
        toast("Late-fee terms saved for this lease.", "good");
        navigate(location.pathname, { replace: true });
      },
    });
  };

  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "card__header" },
      h("h2", { class: "card__title" }, "Late fees"),
      editable
        ? h(
            "div",
            { class: "row" },
            h("button", { class: "btn btn--ghost", type: "button", onClick: form }, own ? "Change" : "Set terms for this lease"),
            own
              ? h(
                  "button",
                  {
                    class: "btn btn--quiet",
                    type: "button",
                    onClick: async () => {
                      try {
                        await portfolio.clearLateFee(tenancyId);
                        toast("This lease now follows its property's policy.", "good");
                        navigate(location.pathname, { replace: true });
                      } catch (caught) {
                        reportError(caught);
                      }
                    },
                  },
                  "Use property policy",
                )
              : null,
          )
        : null,
    ),
    source,
    summary,
    own && data.propertyLateFee ? h("p", { class: "field__hint" }, `The property's policy, for comparison: ${data.propertyLateFeeText}`) : null,
  );
}

function documentsCard(tenancyId: string): HTMLElement {
  const manage = can("documents:manage");
  const list = h("div", { "aria-live": "polite" }, h("p", { class: "field__hint" }, "Loading…"));
  const draw = (documents: LeaseDocument[]) =>
    render(
      list,
      documents.length === 0
        ? h("p", { class: "field__hint" }, "No documents on this lease yet.")
        : h("ul", { class: "lease-docs" }, ...documents.map((d) => documentItem(d, manage, () => void load()))),
    );
  const load = async () => {
    try {
      draw((await portfolio.documents(tenancyId)).documents);
    } catch (caught) {
      render(list, h("p", { class: "field__error" }, caught instanceof ApiError ? caught.message : "Could not load documents."));
    }
  };
  void load();

  const upload = () => {
    const file = input({ type: "file", accept: "application/pdf,.pdf", required: true }) as HTMLInputElement;
    const title = input({ required: true, maxlength: "120", placeholder: "Lease agreement 2026–27" });
    const sign = h("input", { type: "checkbox", checked: true }) as HTMLInputElement;
    file.addEventListener("change", () => {
      if (!title.value && file.files?.[0]) title.value = file.files[0].name.replace(/\.pdf$/i, "");
    });
    formDialog({
      title: "Add a lease document",
      intro: "PDF only, up to 15 MB. Everyone on the lease can see and download it.",
      body: [
        field("File", file),
        field("Title", title),
        h("label", { class: "checkbox" }, sign, h("span", {}, "Ask the residents to sign it in the portal")),
      ],
      submitLabel: "Upload",
      submit: async () => {
        const chosen = file.files?.[0];
        if (!chosen) throw new FormError("Choose a PDF.");
        if (chosen.size > 15 * 1024 * 1024) throw new FormError("That file is larger than 15 MB.");
        const result = await portfolio.uploadDocument(tenancyId, chosen, { title: title.value.trim(), requiresSignature: sign.checked });
        draw(result.documents);
        toast("Document added.", "good");
      },
    });
  };

  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "card__header" },
      h("h2", { class: "card__title" }, "Documents"),
      manage ? h("button", { class: "btn btn--ghost", type: "button", onClick: upload }, "+ Add document") : null,
    ),
    list,
  );
}

export function documentItem(d: LeaseDocument, manage: boolean, reload: () => void): HTMLElement {
  const status = d.withdrawnAt
    ? pill("Withdrawn", "muted")
    : !d.requiresSignature
      ? pill("For your records", "info")
      : d.awaitingSignatureFrom.length === 0
        ? pill("Signed by everyone", "success")
        : pill(`Waiting on ${d.awaitingSignatureFrom.join(", ")}`, "warning");
  return h(
    "li",
    { class: ["lease-docs__item", d.withdrawnAt && "is-withdrawn"] },
    h(
      "div",
      {},
      h("a", { href: portfolio.documentUrl(d.id), target: "_blank", rel: "noopener" }, d.title),
      h("div", { class: "field__hint" }, `${d.fileName} · ${Math.max(1, Math.round(d.sizeBytes / 1024))} KB · added ${date(d.uploadedAt.slice(0, 10))}${d.uploadedByName ? ` by ${d.uploadedByName}` : ""}`),
      ...d.signatures.map((s) => h("div", { class: "field__hint" }, `Signed by ${s.name} (“${s.typedName}”) ${dateTime(s.signedAt)}`)),
      h("div", {}, status),
    ),
    h(
      "div",
      { class: "row" },
      h("a", { class: "btn btn--quiet", href: portfolio.documentUrl(d.id, true) }, "Download"),
      manage && !d.withdrawnAt
        ? h(
            "button",
            {
              class: "btn btn--quiet",
              type: "button",
              onClick: async () => {
                try {
                  await portfolio.withdrawDocument(d.id);
                  toast("Withdrawn. Residents no longer see it; it stays in the record.", "good");
                  reload();
                } catch (caught) {
                  reportError(caught);
                }
              },
            },
            "Withdraw",
          )
        : null,
    ),
  );
}

/* ------------------------------------------------------------------ *
 * Settings: applicant screening
 * ------------------------------------------------------------------ */

export function screeningSection(): HTMLElement {
  const provider = input({ maxlength: "80", placeholder: "e.g. TransUnion SmartMove" });
  const url = input({ type: "url", maxlength: "500", placeholder: "https://" });
  const status = h("p", { class: "ws-sub", "aria-live": "polite" }, "Loading…");
  void portfolio
    .screening()
    .then(({ screening }) => {
      provider.value = screening.provider ?? "";
      url.value = screening.url ?? "";
      status.textContent = screening.url ? `Linked: ${screening.provider ?? screening.url}` : "No screening link set.";
    })
    .catch(() => (status.textContent = "Could not load the screening link."));
  const editable = can("policy:configure");
  return h(
    "section",
    { class: "ws-panel", "aria-labelledby": "screening" },
    h("h2", { class: "ws-h3", id: "screening" }, "Applicant screening"),
    h(
      "p",
      { class: "ws-sub" },
      "Credit and background checks need a Social Security number, which this portal does not collect or store. Applicants are screened with an outside provider; the link here is offered whenever you start a new lease.",
    ),
    status,
    editable
      ? h(
          "form",
          {
            class: "ws-policy",
            onSubmit: async (event: SubmitEvent) => {
              event.preventDefault();
              try {
                const { screening } = await portfolio.saveScreening({ provider: provider.value, url: url.value });
                status.textContent = screening.url ? `Linked: ${screening.provider ?? screening.url}` : "No screening link set.";
                toast("Screening link saved.", "good");
              } catch (caught) {
                reportError(caught);
              }
            },
          },
          h("div", { class: "ws-policy__grid" }, field("Provider", provider), field("Applicant link", url, "The page you send applicants to.")),
          h("div", {}, h("button", { class: "ws-btn ws-btn--primary", type: "submit" }, "Save link")),
        )
      : null,
  );
}

/* ------------------------------------------------------------------ *
 * /manage/import
 * ------------------------------------------------------------------ */

const KIND_LABELS: Record<ImportKind, string> = {
  units: "1. Properties and units",
  leases: "2. Leases and residents",
  ledger: "3. Account history",
};

export async function managerImport(mount: HTMLElement): Promise<void> {
  let kind: ImportKind = "units";
  let csv = "";
  let fileName = "";
  const source = input({ maxlength: "60", value: "RentRedi" });
  const file = input({ type: "file", accept: ".csv,text/csv" }) as HTMLInputElement;
  const help = h("p", { class: "ws-sub" });
  const columns = h("p", { class: "ws-sub" });
  const result = h("div", { "aria-live": "polite" });
  const templateLink = h("a", { class: "ws-btn ws-btn--ghost", download: "" }, "Download template") as HTMLAnchorElement;
  const tabs = h("div", { class: "ws-segmented", role: "tablist" });

  const syncKind = () => {
    help.textContent = IMPORT_HELP[kind];
    columns.textContent = `Columns: ${IMPORT_COLUMNS[kind].join(", ")}`;
    templateLink.href = portfolio.templateUrl(kind);
    render(
      tabs,
      ...IMPORT_KINDS.map((k) =>
        h(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": String(k === kind),
            class: ["ws-seg", k === kind && "is-active"],
            onClick: () => {
              kind = k;
              render(result);
              syncKind();
            },
          },
          KIND_LABELS[k],
        ),
      ),
    );
  };

  file.addEventListener("change", async () => {
    const chosen = file.files?.[0];
    csv = chosen ? await chosen.text() : "";
    fileName = chosen?.name ?? "";
    render(result);
  });

  const run = async (dryRun: boolean) => {
    if (!csv) {
      toast("Choose a CSV file first.", "info");
      return;
    }
    render(result, h("p", { class: "ws-sub" }, dryRun ? "Checking…" : "Importing…"));
    try {
      const { report } = await portfolio.runImport({ kind, csv, dryRun, source: source.value });
      render(result, reportView(report, fileName, () => void run(false)));
      if (!dryRun) {
        toast(`Imported ${report.totals.create + report.totals.update} rows.`, "good");
        showLogins(report.logins, "Logins created by this import");
      }
    } catch (caught) {
      render(result, h("p", { class: "field__error" }, caught instanceof ApiError ? caught.message : "The import failed. Nothing was changed."));
    }
  };

  syncKind();
  render(
    mount,
    wsHeader(
      "Import records",
      "Bring properties, leases and account history over from RentRedi or a spreadsheet. Import in order: units, then leases, then history.",
    ),
    h(
      "section",
      { class: "ws-panel" },
      tabs,
      help,
      columns,
      h("p", { class: "ws-sub" }, "Headers are forgiving (“Unit”, “Tenant Name” and “Start Date” are understood). Save from Excel as “CSV UTF-8”."),
      h("div", { class: "ws-policy__grid" }, field("CSV file", file), field("Where these records came from", source, "Recorded on every imported ledger row.")),
      h(
        "div",
        { class: "ws-toolbar" },
        templateLink,
        wsButton("Check file (changes nothing)", { onClick: () => void run(true) }),
      ),
      result,
    ),
  );
}

function reportView(report: ImportReport, fileName: string, commit: () => void): HTMLElement {
  const t = report.totals;
  const tone = (s: string): Tone => (s === "error" ? "danger" : s === "skip" ? "muted" : s === "update" ? "info" : "success");
  return h(
    "div",
    { class: "ws-stack" },
    h(
      "p",
      { class: "ws-sub" },
      `${report.dryRun ? "Check of" : "Imported"} ${fileName || "file"}: `,
      `${t.create} to add, ${t.update} to update, ${t.skip} already there, ${t.error} with problems.`,
    ),
    report.dryRun && t.create + t.update > 0
      ? h(
          "div",
          {},
          wsButton(`Import ${t.create + t.update} rows${t.error ? ` (skip ${t.error} with problems)` : ""}`, { onClick: commit }),
        )
      : null,
    h(
      "div",
      { class: "ws-table-wrap" },
      h(
        "table",
        { class: "ws-table ws-table--plain" },
        h("thead", {}, h("tr", {}, h("th", {}, "Row"), h("th", {}, "Result"), h("th", {}, "Detail"))),
        h(
          "tbody",
          {},
          ...report.rows.map((r) =>
            h("tr", {}, h("td", {}, String(r.row)), h("td", {}, pill(r.status, tone(r.status), true)), h("td", { class: "ws-wrap" }, r.message)),
          ),
        ),
      ),
    ),
  );
}


/* ------------------------------------------------------------------ *
 * Changing the numbers: charges, credits, corrections, recurring charges
 * ------------------------------------------------------------------ */

const CHARGE_CATEGORIES: Array<[string, string]> = [
  ["rent", "Rent"], ["prorated_rent", "Prorated rent"], ["utility", "Utility"], ["parking", "Parking"],
  ["pet_rent", "Pet rent"], ["late_fee", "Late fee"], ["nsf_fee", "Returned-payment fee"], ["deposit", "Deposit"], ["other", "Other"],
];
const CREDIT_CATEGORIES: Array<[string, string]> = [
  ["concession", "Concession"], ["maintenance_credit", "Maintenance credit"], ["other", "Other"],
];

function selectOf(options: Array<[string, string]>, value?: string): HTMLSelectElement {
  fieldSeq += 1;
  return h(
    "select",
    { class: "select", id: `pf-${fieldSeq}` },
    ...options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)),
  ) as HTMLSelectElement;
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * A one-off charge (a utility bill, a repair the resident caused) or credit
 * (a concession). It is added as its own line with the reason, like every
 * change to the ledger; nothing already there is edited.
 */
export function openAdjustDialog(lease: { tenancyId: string; unitLabel: string; residentName?: string }, onDone?: () => void): void {
  const kind = selectOf([["charge", "Charge (adds to what is owed)"], ["credit", "Credit (reduces what is owed)"]]);
  const category = selectOf(CHARGE_CATEGORIES, "utility");
  kind.addEventListener("change", () => {
    const list = kind.value === "charge" ? CHARGE_CATEGORIES : CREDIT_CATEGORIES;
    category.replaceChildren(...list.map(([v, label]) => h("option", { value: v }, label)));
  });
  const amount = input({ inputmode: "decimal", required: true, placeholder: "45.00" });
  const description = input({ required: true, maxlength: "300", placeholder: "Water bill, August" });
  const on = input({ type: "date", value: todayIso() });
  fieldSeq += 1;
  const reason = h("textarea", { class: "textarea", id: `pf-${fieldSeq}`, required: true, minlength: "4", maxlength: "1000", placeholder: "Why, in a sentence. The resident sees this." }) as HTMLTextAreaElement;

  formDialog({
    title: `Charge or credit — unit ${lease.unitLabel}${lease.residentName ? `, ${lease.residentName}` : ""}`,
    intro: "Added as a new line on the ledger with your name and reason. The resident is notified.",
    body: [
      h("div", { class: "ws-form-row" }, field("Type", kind), field("Category", category)),
      h("div", { class: "ws-form-row" }, field("Amount ($)", amount), field("Date", on)),
      field("Description", description, "What the resident will see on the line."),
      field("Reason", reason),
    ],
    submitLabel: "Add to ledger",
    submit: async () => {
      const cents_ = cents(amount, "Amount", { required: true });
      if (cents_ === 0) throw new FormError("Enter an amount above zero.");
      await manager.adjust({
        tenancyId: lease.tenancyId,
        category: category.value,
        amountCents: kind.value === "charge" ? cents_ : -cents_,
        description: description.value.trim(),
        effectiveDate: on.value || undefined,
        reason: reason.value.trim(),
      });
      toast(kind.value === "charge" ? "Charge added." : "Credit added.", "good");
      onDone ? onDone() : navigate(location.pathname + location.search, { replace: true });
    },
  });
}

/** Undo a line entered by mistake: a reversing line, never a deletion. */
export function openReverseDialog(entry: { id: string; description: string; amountCents: number }): void {
  fieldSeq += 1;
  const reason = h("textarea", { class: "textarea", id: `pf-${fieldSeq}`, required: true, minlength: "4", maxlength: "1000", placeholder: "Entered twice by mistake." }) as HTMLTextAreaElement;
  formDialog({
    title: "Reverse this line",
    intro: `“${entry.description}” (${money(entry.amountCents)}) stays on the ledger, crossed out, with a new line that cancels it and your reason.`,
    body: [field("Reason", reason)],
    submitLabel: "Reverse",
    submit: async () => {
      await manager.reverse({ ledgerEntryId: entry.id, reason: reason.value.trim() });
      toast("Reversed.", "good");
      navigate(location.pathname + location.search, { replace: true });
    },
  });
}

/** Lines a manager may reverse: ones the office entered, not bank payments or the rent job's own charges (waive those). */
export function reversible(entry: { entryType: string; category: string; reversedByEntryId?: string | null; actorRole?: string | null }): boolean {
  if (entry.reversedByEntryId || entry.entryType === "reversal" || entry.entryType === "annotation") return false;
  if (entry.entryType === "adjustment" || entry.entryType === "credit") return true;
  return entry.entryType === "payment" && ["payment_check", "payment_cash", "payment_money_order"].includes(entry.category);
}

function recurringCard(tenancyId: string, active: boolean): HTMLElement {
  const canPost = can("charges:post") && active;
  const body = h("div", { "aria-live": "polite" }, h("p", { class: "field__hint" }, "Loading…"));
  const draw = (charges: Awaited<ReturnType<typeof portfolio.recurring>>["charges"]) =>
    render(
      body,
      charges.length === 0
        ? h("p", { class: "field__hint" }, "None. Rent is the only monthly charge on this lease.")
        : h(
            "ul",
            { class: "lease-people" },
            ...charges.map((c) =>
              h(
                "li",
                { class: ["lease-people__item", !c.active && "is-withdrawn"] },
                h(
                  "div",
                  {},
                  h("strong", {}, `${c.description} — ${money(c.amountCents)} a month`),
                  h("div", { class: "field__hint" }, `Posted on day ${c.dayOfMonth} · from ${date(c.startsOn)}${c.endsOn ? ` to ${date(c.endsOn)}` : ""}${c.active ? "" : " · stopped"}`),
                ),
                canPost && c.active
                  ? h(
                      "button",
                      {
                        class: "btn btn--quiet",
                        type: "button",
                        onClick: async () => {
                          try {
                            draw((await portfolio.stopRecurring(c.id)).charges);
                            toast("Stopped. Months already posted stay on the ledger.", "good");
                          } catch (caught) {
                            reportError(caught);
                          }
                        },
                      },
                      "Stop",
                    )
                  : null,
              ),
            ),
          ),
    );
  portfolio.recurring(tenancyId).then((r) => draw(r.charges)).catch((caught) =>
    render(body, h("p", { class: "field__error" }, caught instanceof ApiError ? caught.message : "Could not load monthly charges.")),
  );

  const add = () => {
    const category = selectOf([["parking", "Parking"], ["pet_rent", "Pet rent"], ["utility", "Utility"], ["other", "Other"]]);
    const amount = input({ inputmode: "decimal", required: true, placeholder: "25.00" });
    const description = input({ required: true, maxlength: "200", placeholder: "Covered parking, space 12" });
    const day = input({ type: "number", min: "1", max: "28", value: "1" });
    const starts = input({ type: "date", required: true, value: todayIso().slice(0, 8) + "01" });
    const ends = input({ type: "date" });
    formDialog({
      title: "Add a monthly charge",
      intro: "Posted every month alongside rent until you stop it.",
      body: [
        h("div", { class: "ws-form-row" }, field("Category", category), field("Amount ($ per month)", amount)),
        field("Description", description),
        h("div", { class: "ws-form-row" }, field("Day of month", day), field("Starts", starts), field("Ends", ends, "Blank to keep going.")),
      ],
      submitLabel: "Add monthly charge",
      submit: async () => {
        const result = await portfolio.addRecurring(tenancyId, {
          category: category.value,
          amountCents: cents(amount, "Amount", { required: true }),
          description: description.value.trim(),
          dayOfMonth: Number(day.value || 1),
          startsOn: starts.value,
          endsOn: ends.value || null,
        });
        draw(result.charges);
        toast("Monthly charge added.", "good");
      },
    });
  };

  return h(
    "section",
    { class: "card" },
    h(
      "div",
      { class: "card__header" },
      h("h2", { class: "card__title" }, "Monthly charges besides rent"),
      canPost ? h("button", { class: "btn btn--ghost", type: "button", onClick: add }, "+ Add monthly charge") : null,
    ),
    body,
  );
}

/* ------------------------------------------------------------------ *
 * Pickers: "which lease?" / "which vacant unit?" for actions started
 * from the dashboard rather than from a lease.
 * ------------------------------------------------------------------ */

interface LeasePick {
  tenancyId: string;
  unitLabel: string;
  residentName: string;
  propertyName: string;
  balanceCents: number;
}

export async function pickLease(title: string): Promise<LeasePick | null> {
  const roll = await manager.rentRoll({ limit: 1000 });
  const leases: LeasePick[] = roll.rows.map((r) => ({
    tenancyId: r.tenancyId, unitLabel: r.unitLabel, residentName: r.residentName,
    propertyName: r.propertyName, balanceCents: r.balanceCents,
  }));
  return pickFrom(
    title,
    "Resident",
    leases.map((l) => ({ value: l.tenancyId, label: `${l.residentName} — ${l.propertyName} ${l.unitLabel}${l.balanceCents > 0 ? ` (owes ${money(l.balanceCents)})` : ""}`, item: l })),
  );
}

export async function pickVacantUnit(): Promise<{ id: string; label: string; marketRentCents: number; propertyName: string } | null> {
  const { units } = await manager.units({ occupancy: "vacant" });
  if (units.length === 0) {
    toast("Every unit has a lease. Add a unit first.", "info");
    return null;
  }
  return pickFrom(
    "Start a lease",
    "Vacant unit",
    units.map((u) => ({
      value: u.unitId,
      label: `${u.propertyName} ${u.label} — ${compactMoney(u.marketRentCents)}`,
      item: { id: u.unitId, label: u.label, marketRentCents: u.marketRentCents, propertyName: u.propertyName },
    })),
  );
}

function pickFrom<T>(title: string, label: string, options: Array<{ value: string; label: string; item: T }>): Promise<T | null> {
  return new Promise((resolve) => {
    let chosen: T | null = null;
    const filter = input({ type: "search", placeholder: "Type to narrow the list", autocomplete: "off" });
    fieldSeq += 1;
    const select = h("select", { class: "select", id: `pf-${fieldSeq}`, size: "8", required: true }) as HTMLSelectElement;
    const fill = () => {
      const needle = filter.value.trim().toLowerCase();
      select.replaceChildren(
        ...options.filter((o) => !needle || o.label.toLowerCase().includes(needle)).slice(0, 300).map((o) => h("option", { value: o.value }, o.label)),
      );
      if (select.options.length) select.selectedIndex = 0;
    };
    filter.addEventListener("input", fill);
    fill();
    const dialog = formDialog({
      title,
      body: [field("Find", filter), field(label, select)],
      submitLabel: "Continue",
      submit: async () => {
        const hit = options.find((o) => o.value === select.value);
        if (!hit) throw new FormError("Choose one from the list.");
        chosen = hit.item;
      },
    });
    select.addEventListener("dblclick", () => dialog.querySelector("form")?.requestSubmit());
    dialog.addEventListener("close", () => resolve(chosen));
    const observer = new MutationObserver(() => {
      if (!dialog.isConnected) {
        observer.disconnect();
        resolve(chosen);
      }
    });
    observer.observe(document.body, { childList: true });
  });
}

/* ------------------------------------------------------------------ *
 * Dashboard: do things from where you land
 * ------------------------------------------------------------------ */

export function managerQuickActions(): HTMLElement | null {
  if (!can("portfolio:manage") && !can("ledger:write:discretionary")) return null;
  const run = (work: () => Promise<void>) => () => void work().catch(reportError);
  const actions: HTMLElement[] = [];
  if (can("portfolio:manage")) {
    actions.push(
      wsButton("+ New lease", {
        onClick: run(async () => {
          const unit = await pickVacantUnit();
          if (unit) await openLeaseDialog(unit);
        }),
      }),
      wsButton("+ Add property", { style: "secondary", onClick: () => openPropertyDialog() }),
      wsButton("+ Add unit", { style: "secondary", onClick: run(() => openUnitDialog()) }),
    );
  }
  if (can("ledger:write:discretionary")) {
    actions.push(
      wsButton("Record a payment", {
        style: "secondary",
        onClick: run(async () => {
          const lease = await pickLease("Record an offline payment");
          if (!lease) return;
          const { openRecordPaymentDialog } = await import("./manager-exceptions.ts");
          openRecordPaymentDialog({ tenancyId: lease.tenancyId, unitLabel: lease.unitLabel, amountCents: Math.max(0, lease.balanceCents) });
        }),
      }),
      wsButton("Charge or credit", {
        style: "secondary",
        onClick: run(async () => {
          const lease = await pickLease("Add a charge or credit");
          if (lease) openAdjustDialog(lease, () => navigate(`/manage/tenancy/${lease.tenancyId}`));
        }),
      }),
    );
  }
  if (can("workorder:triage")) {
    actions.push(
      wsButton("Maintenance request", {
        style: "secondary",
        onClick: run(async () => (await import("./manager-maintenance.ts")).openNewRequestDialog("")),
      }),
    );
  }
  actions.push(
    wsButton("Message a resident", {
      style: "secondary",
      onClick: run(async () => (await import("./messages.ts")).openNewThreadDialog()),
    }),
  );
  return h("section", { class: "ws-quickbar", "aria-label": "Quick actions" }, ...actions);
}


/* ------------------------------------------------------------------ *
 * Resident actions usable from any list
 * ------------------------------------------------------------------ */

export function openEditResidentDialog(
  r: { userId: string; name: string; email: string; phone: string | null },
  onDone?: () => void,
): void {
  const person = personFields({ name: r.name, email: r.email, phone: r.phone ?? "" });
  formDialog({
    title: `Edit ${r.name}`,
    intro: "Changing the email changes what they sign in with.",
    body: person.fields,
    submitLabel: "Save",
    submit: async () => {
      await portfolio.updateResident(r.userId, person.value());
      toast("Contact details saved.", "good");
      onDone ? onDone() : navigate(location.pathname + location.search, { replace: true });
    },
  });
}

export async function issueNewPassword(r: { userId: string; name: string; email: string }): Promise<void> {
  try {
    const { temporaryPassword } = await portfolio.resetPassword(r.userId);
    showLogins([{ userId: r.userId, name: r.name, email: r.email, temporaryPassword }], "New temporary password");
  } catch (caught) {
    reportError(caught);
  }
}

/** A small "⋯" menu of row actions that does not open the row itself. */
export function rowMenu(label: string, items: Array<[string, () => void] | null>): HTMLElement {
  const present = items.filter((i): i is [string, () => void] => i !== null);
  const menu = h(
    "div",
    { class: "row-menu__list", role: "menu", hidden: true },
    ...present.map(([text, act]) =>
      h(
        "button",
        {
          type: "button",
          role: "menuitem",
          class: "row-menu__item",
          onClick: (event: MouseEvent) => {
            event.stopPropagation();
            menu.hidden = true;
            act();
          },
        },
        text,
      ),
    ),
  );
  const toggle: HTMLElement = h(
    "button",
    {
      type: "button",
      class: "row-menu__toggle",
      "aria-expanded": "false",
      "aria-haspopup": "menu",
      "aria-label": `Actions for ${label}`,
      onClick: (event: MouseEvent) => {
        event.stopPropagation();
        document.querySelectorAll<HTMLElement>(".row-menu__list").forEach((m) => {
          if (m !== menu) m.hidden = true;
        });
        menu.hidden = !menu.hidden;
        toggle.setAttribute("aria-expanded", String(!menu.hidden));
        if (!menu.hidden) (menu.querySelector("button") as HTMLButtonElement | null)?.focus();
      },
      onKeydown: (event: KeyboardEvent) => event.stopPropagation(),
    },
    "⋯",
  );
  const wrap = h("div", { class: "row-menu", onClick: (e: MouseEvent) => e.stopPropagation() }, toggle, menu);
  menu.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      menu.hidden = true;
      toggle.focus();
    }
  });
  return wrap;
}

document.addEventListener("click", () => {
  document.querySelectorAll<HTMLElement>(".row-menu__list").forEach((m) => (m.hidden = true));
});

/* ------------------------------------------------------------------ *
 * Photos of a property or a unit (019)
 * ------------------------------------------------------------------ */

/**
 * A gallery with its own "+ Add photos". Used on the property page (building
 * photos) and in the unit photo dialog. Several files can be chosen at once;
 * each uploads on its own, so one bad file does not lose the others.
 */
export function photoGallery(propertyId: string, unit?: { id: string; label: string }, onChange?: () => void): HTMLElement {
  const admin = can("portfolio:manage");
  const grid = h("div", { class: "photo-grid", "aria-live": "polite" }, h("p", { class: "field__hint" }, "Loading…"));
  const status = h("p", { class: "field__hint", role: "status" });
  let last: PropertyPhoto[] = [];

  const draw = (photos: PropertyPhoto[]) => {
    last = photos.filter((p) => (unit ? p.unitId === unit.id : p.unitId === null));
    render(
      grid,
      last.length === 0
        ? h("p", { class: "field__hint" }, admin ? `No photos of ${unit ? `unit ${unit.label}` : "the property"} yet.` : "No photos yet.")
        : last.map((p) => photoTile(p)),
    );
  };

  const reload = async () => draw((await portfolio.photos(propertyId, unit?.id)).photos);

  const act = (work: () => Promise<{ photos: PropertyPhoto[] }>, done: string) => async () => {
    try {
      draw((await work()).photos);
      toast(done, "good");
      onChange?.();
    } catch (caught) {
      reportError(caught);
    }
  };

  const photoTile = (p: PropertyPhoto) =>
    h(
      "figure",
      { class: ["photo-tile", p.isCover && "is-cover"] },
      h(
        "a",
        { href: portfolio.photoUrl(p.id), target: "_blank", rel: "noopener", class: "photo-tile__link" },
        h("img", { src: portfolio.photoUrl(p.id), alt: p.caption || `Photo of ${unit ? `unit ${unit.label}` : "the property"}`, loading: "lazy" }),
      ),
      h(
        "figcaption",
        { class: "photo-tile__caption" },
        p.isCover ? h("span", { class: "photo-tile__badge" }, "Cover") : null,
        h("span", {}, p.caption || h("span", { class: "field__hint" }, "No caption")),
        admin
          ? rowMenu(p.caption || "photo", [
              p.isCover ? null : ["Make cover photo", act(() => portfolio.makeCover(p.id), "Cover photo set.")],
              [
                "Edit caption",
                () => {
                  const caption = input({ maxlength: "140", value: p.caption ?? "", placeholder: "Front of the building" });
                  formDialog({
                    title: "Caption",
                    body: [field("Caption", caption)],
                    submitLabel: "Save",
                    submit: async () => {
                      draw((await portfolio.captionPhoto(p.id, caption.value)).photos);
                      toast("Caption saved.", "good");
                    },
                  });
                },
              ],
              ["Remove photo", act(() => portfolio.removePhoto(p.id), "Photo removed.")],
            ])
          : null,
      ),
    );

  fieldSeq += 1;
  const picker = h("input", {
    type: "file",
    id: `pf-${fieldSeq}`,
    accept: "image/jpeg,image/png,image/webp",
    multiple: true,
    class: "visually-hidden",
    onChange: async () => {
      const files = [...(picker.files ?? [])];
      picker.value = "";
      let ok = 0;
      const problems: string[] = [];
      for (const [i, file] of files.entries()) {
        status.textContent = `Uploading ${i + 1} of ${files.length}…`;
        try {
          draw((await portfolio.uploadPhoto(propertyId, file, { unitId: unit?.id })).photos);
          ok += 1;
        } catch (caught) {
          problems.push(`${file.name}: ${caught instanceof ApiError ? caught.message : "could not upload"}`);
        }
      }
      status.textContent = problems.join(" ");
      if (ok) {
        toast(ok === 1 ? "Photo added." : `${ok} photos added.`, "good");
        onChange?.();
      }
    },
  }) as HTMLInputElement;

  void reload().catch((caught) =>
    render(grid, h("p", { class: "field__error" }, caught instanceof ApiError ? caught.message : "Could not load photos.")),
  );

  return h(
    "div",
    { class: "photo-gallery" },
    admin
      ? h(
          "div",
          { class: "ws-toolbar" },
          picker,
          h("label", { class: "ws-btn ws-btn--secondary", for: picker.id, tabindex: "0", role: "button",
            onKeydown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); picker.click(); } } },
            "+ Add photos"),
          h("span", { class: "field__hint" }, "JPEG, PNG or WebP, up to 15 MB each. The first becomes the cover."),
        )
      : null,
    status,
    grid,
  );
}

export function openUnitPhotosDialog(propertyId: string, unit: { id: string; label: string }): void {
  const dialog = h(
    "dialog",
    { class: "dialog dialog--wide" },
    h("div", { class: "dialog__header" }, h("h2", { class: "dialog__title" }, `Photos — unit ${unit.label}`)),
    h(
      "div",
      { class: "dialog__body" },
      h("p", { class: "field__hint" }, "For listing the unit, or as a record of its condition at move-in and move-out. The resident of this unit can see them; neighbours cannot."),
      photoGallery(propertyId, unit, () => (changed = true)),
    ),
    h(
      "div",
      { class: "dialog__footer" },
      h("button", {
        class: "ws-btn ws-btn--primary",
        type: "button",
        onClick: () => {
          closeDialog(dialog);
          if (changed) navigate(location.pathname + location.search, { replace: true });
        },
      }, "Done"),
    ),
  ) as HTMLDialogElement;
  let changed = false;
  dialog.addEventListener("cancel", () => {
    if (changed) setTimeout(() => navigate(location.pathname + location.search, { replace: true }), 0);
  });
  document.body.appendChild(dialog);
  openDialog(dialog);
}

export function photoThumb(photoId: string | null, alt: string): HTMLElement {
  return photoId
    ? h("img", { class: "photo-thumb", src: portfolio.photoUrl(photoId), alt, loading: "lazy" })
    : h("span", { class: "photo-thumb photo-thumb--empty", "aria-hidden": "true" });
}
