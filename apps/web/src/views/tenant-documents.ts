/**
 * /documents — the resident's lease documents, and signing them.
 *
 * Signing records the typed name, the time, and the fingerprint (SHA-256) of
 * the exact file shown here; if the office replaced the file after this page
 * loaded, the signature is refused and the resident is asked to reload.
 */

import { closeDialog, h, openDialog, render } from "../core/dom.ts";
import { ApiError, portfolio } from "../core/api.ts";
import { state, toast } from "../core/app.ts";
import { date, dateTime } from "../core/fmt.ts";
import type { LeaseDocument } from "/shared/portfolio.js";

export async function tenantDocuments(mount: HTMLElement): Promise<void> {
  const { documents } = await portfolio.myDocuments();
  const waiting = documents.filter((d) => d.requiresSignature && !d.signedByMe);

  render(
    mount,
    h(
      "div",
      { class: "container container--narrow stack stack--lg" },
      h(
        "header",
        { class: "page-header" },
        h(
          "div",
          {},
          h("h1", {}, "Documents"),
          h("p", { class: "lede" }, "Your lease and anything else the office has shared with you. Download a copy any time."),
        ),
      ),
      waiting.length
        ? h(
            "div",
            { class: "notice notice--warn" },
            h(
              "div",
              { class: "notice__body" },
              h("span", { class: "notice__title" }, `${waiting.length} ${waiting.length === 1 ? "document needs" : "documents need"} your signature`),
              h("span", {}, "Open each one and read it before you sign."),
            ),
          )
        : null,
      documents.length === 0
        ? h("div", { class: "msg-empty" }, "No documents yet. When the office adds your lease, it will appear here.")
        : h("ul", { class: "lease-docs" }, ...documents.map(documentRow)),
    ),
  );
}

function documentRow(d: LeaseDocument): HTMLElement {
  const needsMe = d.requiresSignature && !d.signedByMe;
  const mine = d.signatures.find((s) => s.userId === state.user?.id);
  return h(
    "li",
    { class: "lease-docs__item card" },
    h(
      "div",
      {},
      h("a", { href: portfolio.documentUrl(d.id), target: "_blank", rel: "noopener", class: "lease-docs__title" }, d.title),
      h("div", { class: "field__hint" }, `Added ${date(d.uploadedAt.slice(0, 10))} · ${Math.max(1, Math.round(d.sizeBytes / 1024))} KB PDF`),
      mine ? h("div", { class: "field__hint" }, `You signed this ${dateTime(mine.signedAt)} as “${mine.typedName}”.`) : null,
      d.requiresSignature && d.awaitingSignatureFrom.length && !needsMe
        ? h("div", { class: "field__hint" }, `Still waiting on: ${d.awaitingSignatureFrom.join(", ")}.`)
        : null,
    ),
    h(
      "div",
      { class: "row" },
      h("a", { class: "btn btn--ghost", href: portfolio.documentUrl(d.id, true) }, "Download"),
      needsMe ? h("button", { class: "btn btn--primary", type: "button", onClick: () => openSignDialog(d) }, "Review and sign") : null,
    ),
  );
}

function openSignDialog(d: LeaseDocument): void {
  const name = h("input", {
    class: "input",
    id: "sign-name",
    required: true,
    maxlength: "120",
    autocomplete: "name",
    value: "",
    placeholder: state.user?.displayName ?? "",
  }) as HTMLInputElement;
  const agree = h("input", { type: "checkbox", id: "sign-agree", required: true }) as HTMLInputElement;
  const error = h("p", { class: "field__error", hidden: true, role: "alert" });
  const submit = h("button", { class: "btn btn--primary", type: "submit" }, "Sign") as HTMLButtonElement;

  const dialog = h(
    "dialog",
    { class: "dialog" },
    h(
      "form",
      {
        method: "dialog",
        onSubmit: async (event: SubmitEvent) => {
          event.preventDefault();
          error.hidden = true;
          submit.disabled = true;
          try {
            await portfolio.sign(d.id, name.value.trim(), d.sha256);
            closeDialog(dialog);
            toast("Signed. The office can see your signature now.", "good");
            const main = document.querySelector("main");
            if (main) await tenantDocuments(main as HTMLElement);
          } catch (caught) {
            error.textContent = caught instanceof ApiError ? caught.message : "That did not go through. Nothing was signed.";
            error.hidden = false;
            submit.disabled = false;
          }
        },
      },
      h("div", { class: "dialog__header" }, h("h2", { class: "dialog__title" }, `Sign “${d.title}”`)),
      h(
        "div",
        { class: "dialog__body" },
        h(
          "p",
          {},
          "Please ",
          h("a", { href: portfolio.documentUrl(d.id), target: "_blank", rel: "noopener" }, "open the document"),
          " and read it first. Typing your name below is your signature on this exact file.",
        ),
        h("label", { class: "field", for: "sign-name" }, h("span", { class: "field__label" }, "Type your full name"), name),
        h(
          "label",
          { class: "checkbox", for: "sign-agree" },
          agree,
          h("span", {}, "I have read this document and agree to sign it electronically."),
        ),
        h("p", { class: "field__hint" }, "Recorded with your signature: the time, your internet address, and a fingerprint of the file."),
        error,
      ),
      h(
        "div",
        { class: "dialog__footer" },
        h("button", { class: "btn btn--ghost", type: "button", onClick: () => closeDialog(dialog) }, "Cancel"),
        submit,
      ),
    ),
  ) as HTMLDialogElement;
  document.body.appendChild(dialog);
  openDialog(dialog);
}
