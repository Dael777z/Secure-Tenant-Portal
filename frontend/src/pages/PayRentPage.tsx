import { useState } from "react";
import { paymentMethodOptions } from "../data/mockData";
import { useTenantData } from "../data/tenantData";
import { messageFor, tenantApi } from "../api/tenant";
import { PlaidLinkButton } from "../components/PlaidLinkButton";
import { formatCurrency } from "../components/formatCurrency";
import type { PaymentMethodKind } from "../types";

const PROCESSING_FEE = 0; //Bank transfer using Plaid - expecting no fees.

export function PayRentPage() {
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethodKind>("bank");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [paidJustNow, setPaidJustNow] = useState(false);
  const { currentBalance, bankAccounts, plaidEnabled, refresh } = useTenantData();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const total = currentBalance + PROCESSING_FEE;
  // Bank transfer only for now (client, 9/27). With Plaid set up, the money
  // comes from the tenant's linked account; without it the payment is recorded
  // as a demo transfer.
  const bankAccount = bankAccounts[0] ?? null;
  const needsBankLink = selectedMethod === "bank" && plaidEnabled && !bankAccount;
  const canPay = selectedMethod === "bank" && total > 0 && !needsBankLink;

  function handlePay() {
    setIsSubmitting(true);
    setPaidJustNow(false);
    setError(null);

    tenantApi
      .pay(Math.round(total * 100) / 100, bankAccount?.id ?? null)
      .then(async (result) => {
        setConfirmation(result.confirmation);
        setPaidJustNow(true);
        await refresh();
      })
      .catch((caught) => setError(messageFor(caught)))
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
              onClick={() => setSelectedMethod(option.kind)}
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

        {selectedMethod === "bank" && bankAccount && (
          <p className="method-note">
            Paying from {bankAccount.name}
            {bankAccount.mask ? ` ••${bankAccount.mask}` : ""}
          </p>
        )}
        {needsBankLink && <PlaidLinkButton onLinked={() => void refresh()} />}
        {selectedMethod === "bank" && !plaidEnabled && (
          <p className="method-note">Demo mode: the payment is recorded, and no money moves.</p>
        )}
        {selectedMethod !== "bank" && (
          <p className="method-note">For now, rent is paid by bank transfer only.</p>
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
          onClick={handlePay}
          disabled={isSubmitting || !canPay}
        >
          {isSubmitting ? "Processing..." : `Pay ${formatCurrency(total)}`}
        </button>

        {paidJustNow && (
          <div className="pay-success-banner" role="status">
            Payment submitted{confirmation ? ` (${confirmation})` : ""}. It now shows in your ledger.
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
