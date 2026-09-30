/**
 * "What this portal shares" — a plain statement of every outside party this
 * deployment talks to.
 *
 * Suggested by the RentRedi tenant-portal audit (rentredi-tenant-audit/
 * 05-gap-analysis, backlog item 9): the current system loads scripts from
 * about thirty outside hosts on pages with financial forms, including session
 * replay and advertising pixels. This project's claim is the opposite, and the
 * claim is only worth something if a resident can read it. Every statement
 * below is enforced elsewhere — by the Content-Security-Policy in
 * apps/api/src/http/server.ts, the cookie settings in the same file, and the
 * self-hosted fonts — so this page describes the system rather than promising
 * a policy.
 *
 * The comparison with RentRedi is shown to management only; it is for the
 * sponsor demo and would be out of place on a resident's screen.
 */

import { h, render } from "../core/dom.ts";
import { isManagerSide } from "../core/app.ts";

const FACTS: Array<{ title: string; body: string }> = [
  {
    title: "No outside scripts",
    body:
      "Every script, stylesheet and font on these pages comes from this server. The browser is told to refuse " +
      "anything else (a Content-Security-Policy of 'self' only), so no analytics, advertising pixel, chat widget " +
      "or session-recording tool can run here, even by mistake. When bank linking arrives, the bank processor's " +
      "own secure form (Plaid Link) will be the one exception, allowed only on the page where you add a bank.",
  },
  {
    title: "One cookie",
    body:
      "A single sign-in cookie that scripts cannot read (HttpOnly), that is never sent from another site " +
      "(SameSite=Strict), and that is sent only over HTTPS in production. There are no tracking or advertising cookies.",
  },
  {
    title: "Who the server talks to",
    body:
      "Only the services your property management company configures: the bank-transfer processor when you pay, " +
      "an email service to send your receipts and notices, and optionally a storage service for maintenance photos. " +
      "Your full bank account number never reaches this server; the processor holds it.",
  },
  {
    title: "Where your records live",
    body:
      "In a database run by your property management company. The database itself limits each person to their own " +
      "records, so a mistake in this website's code cannot show you a neighbour's account or show them yours.",
  },
];

/** From the RentRedi tenant-portal audit (tech/third-party-scripts.txt), 2026-09-28. */
const RENTREDI_HOSTS: Array<{ group: string; hosts: string }> = [
  { group: "Session replay and monitoring", hosts: "Datadog RUM + replay, Sentry, Cloudflare Insights" },
  { group: "Product analytics", hosts: "Heap, Pendo, HubSpot analytics, first-party Google Tag Manager" },
  { group: "Advertising pixels", hosts: "TikTok, Reddit, LinkedIn, Bing, HubSpot ads, Impact" },
  { group: "Support and co-browsing", hosts: "Intercom, Cobrowse.io, HubSpot feedback" },
  { group: "Fraud and bot checks", hosts: "Sift, Google reCAPTCHA Enterprise" },
  { group: "Other", hosts: "Cookiebot, Font Awesome kit, jsDelivr, unpkg, shop.pe, mpio.io, Stripe.js, Plaid" },
];

export async function privacyPage(mount: HTMLElement): Promise<void> {
  const management = isManagerSide();

  render(
    mount,
    h(
      "div",
      { class: "container container--narrow stack stack--lg" },
      h(
        "header",
        {},
        h("h1", {}, "What this portal shares"),
        h(
          "p",
          { class: "lede" },
          "Nothing about how you use this site is sent to advertisers or analytics companies. Here is exactly what leaves it.",
        ),
      ),
      ...FACTS.map((fact) =>
        h("section", { class: "card" }, h("h2", { class: "card__title" }, fact.title), h("p", { class: "field__hint" }, fact.body)),
      ),
      management
        ? h(
            "section",
            { class: "card" },
            h("h2", { class: "card__title" }, "For comparison: the RentRedi tenant portal"),
            h(
              "p",
              { class: "field__hint" },
              "Observed on tenant.rentredi.com on September 28, 2026 during a read-only audit of the sponsor's test unit: " +
                "scripts from about thirty outside hosts load on pages that include payment forms.",
            ),
            h(
              "div",
              { class: "table-wrap" },
              h(
                "table",
                {},
                h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Kind"), h("th", { scope: "col" }, "Services"))),
                h(
                  "tbody",
                  {},
                  ...RENTREDI_HOSTS.map((row) => h("tr", {}, h("td", { class: "nowrap" }, row.group), h("td", {}, row.hosts))),
                  h("tr", {}, h("td", { class: "nowrap" }, h("strong", {}, "This portal")), h("td", {}, h("strong", {}, "None today. Plaid Link will be allowed on the add-a-bank page only."))),
                ),
              ),
            ),
          )
        : null,
    ),
  );
}
