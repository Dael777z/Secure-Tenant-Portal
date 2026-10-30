import { useState } from "react";
import { useTenantData } from "../data/tenantData";
import { messageFor, tenantApi } from "../api/tenant";
import { PlaidLinkButton } from "../components/PlaidLinkButton";
import { formatCurrency } from "../components/formatCurrency";
import type { ManualPayMethod, PaymentMethodKind, PaymentMethodOption } from "../types";

/** A fresh id for one checkout (letters, digits and dashes, as the server expects). */
const newCheckoutKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

// Juan's payment methods (tenant-side-ui 23d7a8e): bank first, then Cash App and Zelle.
const paymentMethodOptions: PaymentMethodOption[] = [
  { kind: "bank", label: "Bank Account", sublabel: "Connected via Plaid" },
  { kind: "cashapp", label: "Cash App", sublabel: "Send from Cash App" },
  { kind: "zelle", label: "Zelle", sublabel: "Send from your bank's app" },
];

const APP_NAMES: Record<ManualPayMethod, string> = { cashapp: "Cash App", zelle: "Zelle" };

const PROCESSING_FEE = 0; // No fee is charged to tenants today (see the implementation plan, A3).

const round2 = (n: number) => Math.round(n * 100) / 100;
/** "1,250.50" or "$950" → 1250.5; null if it isn't a dollar amount with at most two decimals. */
function parseAmount(text: string): number | null {
  const clean = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

export function PayRentPage() {
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethodKind>("bank");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [paidJustNow, setPaidJustNow] = useState(false);
  const { tenant, currentBalance, payLimits, bankAccounts, plaidEnabled, testPayments, payOptions, reportedPayments, refresh } = useTenantData();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept until this checkout succeeds: pressing Pay again (or a retry) reuses it.
  const [checkoutKey, setCheckoutKey] = useState(newCheckoutKey);

  // How much: at least the balance (no partial payments), up to a few months of rent ahead (credit).
  const due = Math.max(currentBalance, 0);
  const credit = Math.max(-currentBalance, 0);
  const rent = payLimits?.monthlyRent ?? 0;
  const maximum = payLimits?.maximum ?? 0;
  const suggested = due > 0 ? due : Math.min(rent, maximum);
  // null = use the suggested amount (it follows the balance after a payment).
  const [amountText, setAmountText] = useState<string | null>(null);
  const shownText = amountText ?? (suggested > 0 ? suggested.toFixed(2) : "");
  const amount = parseAmount(shownText);
  const amountProblem =
    !payLimits || !payLimits.canPay
      ? null
      : amount === null
        ? "Enter an amount in dollars, like 950.00."
        : amount < payLimits.minimum
          ? due > 0
            ? `Pay at least the full balance of ${formatCurrency(due)}. Partial payments aren't accepted.`
            : `The smallest payment is ${formatCurrency(payLimits.minimum)}.`
          : amount > maximum
            ? `The most you can pay now is ${formatCurrency(maximum)} (up to ${payLimits.prepayMonths} months of rent ahead).`
            : null;
  const valid = Boolean(payLimits?.canPay) && amount !== null && amountProblem === null;
  const payingAhead = valid && amount !== null ? round2(amount - due) : 0;
  const total = valid && amount !== null ? round2(amount + PROCESSING_FEE) : 0;
  // One-tap amounts that fit under the limit.
  const choices = (
    due > 0
      ? [
          { label: "Amount due", value: due },
          { label: "+ next month", value: round2(due + rent) },
        ]
      : [
          { label: "1 month", value: rent },
          { label: "2 months", value: round2(rent * 2) },
          { label: "3 months", value: round2(rent * 3) },
        ]
  ).filter((c) => c.value > 0 && c.value <= maximum + 0.001);

  const manual = selectedMethod === "bank" ? null : selectedMethod;
  // The office's own handle for Cash App / Zelle (Settings on the manager side).
  const sendTo = manual ? { app: APP_NAMES[manual], handle: payOptions[manual] } : null;
  // Goes in the memo so the office can match the payment to the tenant.
  const reference = `${tenant.unitLabel} - ${tenant.name}`;
  // One payment at a time: a Cash App / Zelle report waiting for the office.
  const waiting = reportedPayments.find((r) => r.status === "pending") ?? null;
  const lastDecision = reportedPayments.find((r) => r.status !== "pending") ?? null;

  const bankAccount = bankAccounts[0] ?? null;
  const needsBankLink = selectedMethod === "bank" && plaidEnabled && !bankAccount;
  const unavailable = selectedMethod === "bank" && !plaidEnabled && !testPayments;
  const canPay =
    valid &&
    !waiting &&
    (selectedMethod === "bank" ? !needsBankLink && !unavailable : Boolean(sendTo?.handle));

  function selectMethod(kind: PaymentMethodKind) {
    setSelectedMethod(kind);
    setPaidJustNow(false);
    setError(null);
  }

  function finish(result: { confirmation: string }) {
    setConfirmation(result.confirmation);
    setPaidJustNow(true);
    setCheckoutKey(newCheckoutKey()); // the next payment is a new checkout
    setAmountText(null); // back to the suggested amount for the new balance
    return refresh();
  }

  function handlePay() {
    setIsSubmitting(true);
    setPaidJustNow(false);
    setError(null);
    const request = manual
      ? tenantApi.reportPayment(manual, total, checkoutKey) // "I've sent it"
      : tenantApi.pay(total, bankAccount?.id ?? null, checkoutKey);
    request
      .then(finish)
      .catch(async (caught) => {
        setError(messageFor(caught));
        await refresh(); // e.g. the balance changed, or a report is already waiting
      })
      .finally(() => setIsSubmitting(false));
  }

  return (
    <div className="pay-grid">
      <section className="portal-panel" aria-labelledby="payment-method-heading">
        <h2 id="payment-method-heading" className="portal-panel-title" style={{ fontSize: 15 }}>
          Payment method
        </h2>
        <div className="method-grid" role="radiogroup" aria-labelledby="payment-method-heading">
          {paymentMethodOptions.map((option) => (
            <button
              key={option.kind}
              type="button"
              role="radio"
              aria-checked={selectedMethod === option.kind}
              className="method-option"
              onClick={() => selectMethod(option.kind)}
            >
              <span className="method-radio" aria-hidden="true" />
              <span>
                <span className="method-label">{option.label}</span>
                <br />
                <span className="method-sublabel">
                  {option.kind !== "bank" && !payOptions[option.kind] ? "Not offered right now" : option.sublabel}
                </span>
              </span>
            </button>
          ))}
        </div>

        {selectedMethod === "bank" && bankAccount && (
          <p className="method-note">
            Paying from {bankAccount.name}
            {bankAccount.mask ? ` ••${bankAccount.mask}` : ""}
          </p>
        )}
        {needsBankLink && <PlaidLinkButton onLinked={() => void refresh()} />}
        {selectedMethod === "bank" && !plaidEnabled && testPayments && (
          <p className="method-note">Test mode (Plaid is not connected): the payment is recorded, and no money moves.</p>
        )}
        {unavailable && <p className="method-note">Online payment is not available right now. Please pay the leasing office directly.</p>}

        {sendTo &&
          (sendTo.handle ? (
            <ManualPayInstructions app={sendTo.app} handle={sendTo.handle} amount={valid ? formatCurrency(total) : "Enter the amount first"} reference={reference} />
          ) : (
            <p className="method-note">The office isn't taking {sendTo.app} payments right now. Choose another method.</p>
          ))}
      </section>

      <section className="portal-panel" aria-labelledby="payment-summary-heading">
        <h2 id="payment-summary-heading" className="portal-panel-title" style={{ fontSize: 15 }}>
          Payment Summary
        </h2>
        <div className="summary-amount">{formatCurrency(total)}</div>

        {payLimits && payLimits.canPay && (
          <div className="pay-amount">
            <label className="field-label" htmlFor="pay-amount">
              Amount to pay
            </label>
            <div className="pay-amount-input">
              <span aria-hidden="true">$</span>
              <input
                id="pay-amount"
                className="field-input"
                inputMode="decimal"
                autoComplete="off"
                value={shownText}
                onChange={(e) => {
                  setAmountText(e.target.value);
                  setPaidJustNow(false);
                  setError(null);
                }}
                aria-invalid={amountProblem ? true : undefined}
                aria-describedby="pay-amount-help"
              />
            </div>
            {choices.length > 0 && (
              <div className="pay-amount-choices" role="group" aria-label="Quick amounts">
                {choices.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    className="pay-amount-choice"
                    aria-pressed={amount !== null && Math.abs(amount - c.value) < 0.005}
                    onClick={() => setAmountText(c.value.toFixed(2))}
                  >
                    {c.label} · {formatCurrency(c.value)}
                  </button>
                ))}
              </div>
            )}
            <p id="pay-amount-help" className={amountProblem ? "pay-amount-help pay-amount-help--error" : "pay-amount-help"}>
              {amountProblem ??
                (due > 0
                  ? `The full balance, or more to pay ahead (up to ${payLimits.prepayMonths} months of rent). Anything extra is credit toward your next rent.`
                  : `Nothing is due. You can pay ahead up to ${formatCurrency(maximum)}; it's credit toward your next rent.`)}
            </p>
          </div>
        )}
        {payLimits && !payLimits.canPay && (
          <p className="method-note">You're paid {payLimits.prepayMonths} months ahead, the most the portal takes. Nothing to pay right now.</p>
        )}
        {!payLimits && <p className="method-note">There's no active lease on your account yet.</p>}

        <div className="summary-row">
          <span>Balance due</span>
          <span>{formatCurrency(due)}</span>
        </div>
        {credit > 0 && (
          <div className="summary-row">
            <span>Credit on your account</span>
            <span>{formatCurrency(credit)}</span>
          </div>
        )}
        {payingAhead > 0 && (
          <div className="summary-row">
            <span>Paying ahead (credit)</span>
            <span>{formatCurrency(payingAhead)}</span>
          </div>
        )}
        <div className="summary-row">
          <span>Processing fee</span>
          <span>{formatCurrency(PROCESSING_FEE)}</span>
        </div>
        <div className="summary-row summary-row--total">
          <span>Total</span>
          <span>{formatCurrency(total)}</span>
        </div>

        <button
          type="button"
          className="btn btn--primary"
          style={{ width: "100%", marginTop: 16 }}
          onClick={handlePay}
          disabled={isSubmitting || !canPay}
        >
          {isSubmitting ? "Processing..." : sendTo ? `I've sent ${formatCurrency(total)}` : `Pay ${formatCurrency(total)}`}
        </button>

        {waiting && !paidJustNow && (
          <div className="pay-pending-banner" role="status">
            Your {APP_NAMES[waiting.method]} payment of {formatCurrency(waiting.amount)} (sent {waiting.reportedOn}) is waiting for the
            office to confirm it. It will show in your ledger once they do.
          </div>
        )}
        {!waiting && lastDecision?.status === "rejected" && (
          <div className="login-error" role="alert" style={{ marginTop: 12 }}>
            The office couldn't match your {APP_NAMES[lastDecision.method]} payment of {formatCurrency(lastDecision.amount)} (sent{" "}
            {lastDecision.reportedOn}): {lastDecision.reason}. Check your {APP_NAMES[lastDecision.method]} app, or pay again.
          </div>
        )}
        {paidJustNow && !waiting && (
          <div className="pay-success-banner" role="status">
            Payment submitted{confirmation ? ` (${confirmation})` : ""}. It now shows in your ledger
            {currentBalance < 0 ? `, with ${formatCurrency(-currentBalance)} credit toward your next rent` : ""}.
          </div>
        )}
        {paidJustNow && waiting && (
          <div className="pay-success-banner" role="status">
            Thanks. Once the office sees your {APP_NAMES[waiting.method]} payment, it will show in your ledger.
          </div>
        )}
        {error && (
          <div className="login-error" role="alert" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
      </section>
    </div>
  );
}

interface ManualPayInstructionsProps {
  app: string;
  handle: string;
  amount: string;
  reference: string;
}

// Steps for paying by Cash App or Zelle, with copy buttons for the details (Juan's design).
function ManualPayInstructions({ app, handle, amount, reference }: ManualPayInstructionsProps) {
  return (
    <div className="manual-pay">
      <p className="manual-pay-title">Pay with {app}</p>
      <CopyRow label="Send to" value={handle} />
      <CopyRow label="Amount" value={amount} />
      <CopyRow label="Note / memo" value={reference} />
      <p className="method-note">
        Send exactly this amount in {app} with the note above, then tap "I've sent" so the office can match it.
        Partial payments aren't accepted.
      </p>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    // Clipboard can be blocked (insecure page, permissions)
    navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }

  return (
    <div className="copy-row">
      <div>
        <div className="copy-row-label">{label}</div>
        <div className="copy-row-value">{value}</div>
      </div>
      <button type="button" className="btn btn--outline copy-row-btn" onClick={handleCopy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
