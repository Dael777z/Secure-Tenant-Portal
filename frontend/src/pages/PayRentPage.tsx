import { useState } from "react";
import { currentBalance, paymentMethodOptions } from "../data/mockData";
import { formatCurrency } from "../components/formatCurrency";
import type { PaymentMethodKind } from "../types";

const PROCESSING_FEE = 0; //Bank transfer using Plaid - expecting no fees.

export function PayRentPage() {
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethodKind>("bank");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [paidJustNow, setPaidJustNow] = useState(false);

  const total = currentBalance + PROCESSING_FEE;

  function handlePay() {
    setIsSubmitting(true);
    setPaidJustNow(false);

    window.setTimeout(() => {
      setIsSubmitting(false);
      setPaidJustNow(true);
    }, 700);
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
          disabled={isSubmitting}
        >
          {isSubmitting ? "Processing..." : `Pay ${formatCurrency(total)}`}
        </button>

        {paidJustNow && (
          <div className="pay-success-banner" role="status">
            Payment submitted. Your receipt will appear in the ledger once it's confirmed.
          </div>
        )}
      </section>
    </div>
  );
}
