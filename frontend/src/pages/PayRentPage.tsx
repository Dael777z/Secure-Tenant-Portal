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

export function PayRentPage() {
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethodKind>("bank");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [paidJustNow, setPaidJustNow] = useState(false);
  const { tenant, currentBalance, bankAccounts, plaidEnabled, testPayments, payOptions, reportedPayments, refresh } = useTenantData();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept until this checkout succeeds: pressing Pay again (or a retry) reuses it.
  const [checkoutKey, setCheckoutKey] = useState(newCheckoutKey);

  const total = currentBalance + PROCESSING_FEE;
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
    total > 0 &&
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
    return refresh();
  }

  function handlePay() {
    setIsSubmitting(true);
    setPaidJustNow(false);
    setError(null);
    const amount = Math.round(total * 100) / 100;
    const request = manual
      ? tenantApi.reportPayment(manual, amount, checkoutKey) // "I've sent it"
      : tenantApi.pay(amount, bankAccount?.id ?? null, checkoutKey);
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
            <ManualPayInstructions app={sendTo.app} handle={sendTo.handle} amount={formatCurrency(total)} reference={reference} />
          ) : (
            <p className="method-note">The office isn't taking {sendTo.app} payments right now. Choose another method.</p>
          ))}
      </section>

      <section className="portal-panel" aria-labelledby="payment-summary-heading">
        <h2 id="payment-summary-heading" className="portal-panel-title" style={{ fontSize: 15 }}>
          Payment Summary
        </h2>
        <div className="summary-amount">{formatCurrency(total)}</div>

        <div className="summary-row">
          <span>Rent due</span>
          <span>{formatCurrency(currentBalance)}</span>
        </div>
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
            Payment submitted{confirmation ? ` (${confirmation})` : ""}. It now shows in your ledger.
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
        Send the full amount in {app} with the note above, then tap "I've sent" so the office can match it.
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
