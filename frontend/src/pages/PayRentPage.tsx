import { useEffect, useRef, useState } from "react";

/** A fresh id for one checkout (letters, digits and dashes, as the server expects). */
const newCheckoutKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
import { useTenantData } from "../data/tenantData";
import { messageFor, tenantApi, type CashAppStatus } from "../api/tenant";
import { PlaidLinkButton } from "../components/PlaidLinkButton";
import { confirmWithCashApp, takeCashAppReturn } from "../components/cashApp";
import { describeRate, processingFee } from "../components/fees";
import { formatCurrency } from "../components/formatCurrency";
import type { PaymentMethodKind, PaymentMethodOption } from "../types";

export function PayRentPage() {
  const { currentBalance, bankAccounts, plaidEnabled, testPayments, cashAppEnabled, stripePublishableKey, cashAppFee, refresh } = useTenantData();
  const [selectedMethod, setSelectedMethod] = useState<PaymentMethodKind>("bank");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [paidJustNow, setPaidJustNow] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept until this checkout succeeds: pressing Pay again (or a retry) reuses it.
  const [checkoutKey, setCheckoutKey] = useState(newCheckoutKey);

  // Bank account first (client, 9/27); Cash App Pay through Stripe when the server has keys.
  const paymentMethodOptions: PaymentMethodOption[] = [
    { kind: "bank", label: "Bank Account", sublabel: "Connected via Plaid" },
    {
      kind: "cashapp",
      label: "Cash App Pay",
      sublabel: cashAppEnabled ? `${cashAppFee ? `${describeRate(cashAppFee)} fee` : "Scan or open Cash App"}` : "Not available yet",
    },
    { kind: "card", label: "Credit/Debit Card", sublabel: "Not available yet" },
    { kind: "other", label: "Other", sublabel: "Pay the leasing office" },
  ];

  // Bank transfers have no fee; Cash App Pay's processor fee is passed on (the server works out the same figure).
  const fee = selectedMethod === "cashapp" && cashAppFee && currentBalance > 0 ? processingFee(currentBalance, cashAppFee) : 0;
  const total = Math.round((currentBalance + fee) * 100) / 100;
  // A checkout is for one amount: when the balance changes, the next Pay is a new checkout.
  const checkoutAmount = useRef(total);
  useEffect(() => {
    if (checkoutAmount.current !== total) {
      checkoutAmount.current = total;
      setCheckoutKey(newCheckoutKey());
    }
  }, [total]);

  // Bank transfer from the tenant's Plaid-linked account. In development without
  // Plaid keys, the server records a test transfer.
  const bankAccount = bankAccounts[0] ?? null;
  const needsBankLink = selectedMethod === "bank" && plaidEnabled && !bankAccount;
  const bankUnavailable = selectedMethod === "bank" && !plaidEnabled && !testPayments;
  const canPay =
    total > 0 &&
    ((selectedMethod === "bank" && !needsBankLink && !bankUnavailable) || (selectedMethod === "cashapp" && cashAppEnabled));

  /** Show how a Cash App payment ended up, after Stripe.js or after coming back from Cash App. */
  async function settleCashApp(paymentIntentId: string) {
    const result: { status: CashAppStatus; confirmation: string } = await tenantApi.refreshCashApp(paymentIntentId);
    if (result.status === "completed") {
      setConfirmation(result.confirmation);
      setPaidJustNow(true);
      setCheckoutKey(newCheckoutKey()); // the next payment is a new checkout
    } else if (result.status === "failed") {
      setError("That Cash App payment was canceled. You can try again.");
      setCheckoutKey(newCheckoutKey());
    } else {
      // Not finished yet (still in Cash App, or declined and can be retried with the same checkout).
      setProcessing(true);
    }
    await refresh();
  }

  // Back from Cash App on a phone: finish what that checkout started.
  useEffect(() => {
    const returned = takeCashAppReturn();
    if (!returned) return;
    setSelectedMethod("cashapp");
    setIsSubmitting(true);
    settleCashApp(returned)
      .catch((caught) => setError(messageFor(caught)))
      .finally(() => setIsSubmitting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function payWithCashApp() {
    // The rent being paid; the server adds the processing fee to what Cash App charges.
    const checkout = await tenantApi.startCashApp(Math.round(currentBalance * 100) / 100, checkoutKey);
    const { paymentIntentId, error: cashAppError } = await confirmWithCashApp(stripePublishableKey!, checkout.clientSecret);
    if (cashAppError) {
      setError(cashAppError); // same checkout key: trying again resumes this payment
      return;
    }
    await settleCashApp(paymentIntentId ?? checkout.paymentIntentId);
  }

  async function payFromBank() {
    const result = await tenantApi.pay(Math.round(total * 100) / 100, bankAccount?.id ?? null, checkoutKey);
    setConfirmation(result.confirmation);
    setPaidJustNow(true);
    setCheckoutKey(newCheckoutKey()); // the next payment is a new checkout
    await refresh();
  }

  function handlePay() {
    setIsSubmitting(true);
    setPaidJustNow(false);
    setProcessing(false);
    setError(null);
    (selectedMethod === "cashapp" ? payWithCashApp() : payFromBank())
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
        {selectedMethod === "bank" && !plaidEnabled && testPayments && (
          <p className="method-note">Test mode (Plaid is not connected): the payment is recorded, and no money moves.</p>
        )}
        {bankUnavailable && (
          <p className="method-note">Online payment is not available right now. Please pay the leasing office directly.</p>
        )}
        {selectedMethod === "cashapp" && cashAppEnabled && (
          <p className="method-note">
            After you press Pay, scan the QR code with Cash App on your phone (or, on your phone, approve it in Cash App).
            The payment shows in your ledger once Cash App confirms it.
          </p>
        )}
        {selectedMethod === "cashapp" && !cashAppEnabled && (
          <p className="method-note">Cash App Pay is not available right now. Please use a bank account or pay the leasing office.</p>
        )}
        {(selectedMethod === "card" || selectedMethod === "wallet" || selectedMethod === "other") && (
          <p className="method-note">For now, rent is paid by bank transfer or Cash App Pay.</p>
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
          <span>{formatCurrency(fee)}</span>
        </div>
        <p className="summary-fee-note">
          {selectedMethod === "cashapp" && cashAppFee
            ? `Cash App Pay charges ${describeRate(cashAppFee)} per payment. It's added here so your full rent reaches the office.`
            : "No fee for bank transfers."}
        </p>
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
        {processing && (
          <div className="pay-success-banner" role="status">
            Your Cash App payment is not finished yet. It shows in your ledger as soon as Cash App confirms it.
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
