import { useState } from "react";
import { currentBalance, paymentMethodOptions, mockTenant } from "../data/mockData";
import { formatCurrency } from "../components/formatCurrency";
import type { PaymentMethodKind } from "../types";


const PROCESSING_FEE = 0; //Bank transfer using Plaid - expecting no fees. placeholders
const SEND_TO: Partial<Record<PaymentMethodKind, { app: string; handle: string }>> = {
  cashapp: { app: "Cash App", handle: "$SummitPM" },
  zelle: { app: "Zelle", handle: "payments@summitpm.example" },
};

export function PayRentPage() {
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethodKind>("bank");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [paidJustNow, setPaidJustNow] = useState(false);

  //Set when the tenant says they sent a Cash App / Zelle payment.
  const [reportedVia, setReportedVia] = useState<PaymentMethodKind | null>(null);

  const total = currentBalance + PROCESSING_FEE;
  const sendTo = SEND_TO[selectedMethod] ?? null;
  //Goes in the memo so the office can match the payment to the tenant.
  const reference = `${mockTenant.unitLabel} - ${mockTenant.name}`;

  function selectMethod(kind: PaymentMethodKind) {
    setSelectedMethod(kind);
    setReportedVia(null);
    setPaidJustNow(false);
  }

  function handlePay() {
    setIsSubmitting(true);
    setPaidJustNow(false);

    window.setTimeout(() => {
      setIsSubmitting(false);
      setPaidJustNow(true);
    }, 700);
  }

  //Cash App / Zelle are sent and records that they say they sent it
  function handleReport() {
    setReportedVia(selectedMethod);
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
                <span className="method-sublabel">{option.sublabel}</span>
              </span>
            </button>
          ))}
        </div>
        {sendTo && (
          <ManualPayInstructions
            app={sendTo.app}
            handle={sendTo.handle}
            amount={formatCurrency(total)}
            reference={reference}
          />
        )}

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
          onClick={sendTo ? handleReport : handlePay}
          disabled={isSubmitting}
        >
          {sendTo
            ? `I've sent ${formatCurrency(total)}`
            : isSubmitting
              ? "Processing..."
              : `Pay ${formatCurrency(total)}`}
        </button>

        {paidJustNow && (
          <div className="pay-success-banner" role="status">
            Payment submitted. Your receipt will appear in the ledger once it's confirmed.
          </div>
        )}
        {reportedVia && SEND_TO[reportedVia] && (
          <div className="pay-success-banner" role="status">
            Thanks. Once the office sees your {SEND_TO[reportedVia]!.app} payment, it will show in your ledger.
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

// Steps for paying by Cash App or Zelle, with copy buttons for the details
function ManualPayInstructions({ app, handle, amount, reference }: ManualPayInstructionsProps) {
  return (
    <div className="manual-pay">
      <p className="manual-pay-title">Pay with {app}</p>
      <CopyRow label="Send to" value={handle} />
      <CopyRow label="Amount" value={amount} />
      <CopyRow label="Note / memo" value={reference} />
      <p className="method-note">
        Send the full amount from your {app} app with the note above, then tap "I've sent" so the office can
        match it. Partial payments aren't accepted.
      </p>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    //Clipboard can be blocked (insecure page, permissions)
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
