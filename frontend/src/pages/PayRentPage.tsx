import { useEffect, useRef, useState } from "react";
import { useTenantData } from "../data/tenantData";
import { ApiError, PHOTO_ACCEPT, messageFor, readPhoto, tenantApi } from "../api/tenant";
import { CardPayment, type CardFormHandle } from "../components/CardPayment";
import { PlaidLinkButton } from "../components/PlaidLinkButton";
import { describeRate, processingFee } from "../components/fees";
import { formatCurrency } from "../components/formatCurrency";
import { stripeClient, takeStripeReturn } from "../components/stripeClient";
import type { ManualPayMethod, PaymentMethodKind, PaymentMethodOption } from "../types";

/** A fresh id for one checkout (letters, digits and dashes, as the server expects). */
const newCheckoutKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

// Juan's payment methods (tenant-side-ui 23d7a8e): bank first, then Cash App and Zelle.
// 010: cards, and Apple Pay / Google Pay, through Stripe, after the bank.
const paymentMethodOptions: PaymentMethodOption[] = [
  { kind: "bank", label: "Bank Account", sublabel: "Connected via Plaid" },
  { kind: "card", label: "Credit/Debit Card", sublabel: "Visa, Mastercard, Amex, Discover" },
  { kind: "wallet", label: "Apple Pay / Google Pay", sublabel: "On supported devices" },
  { kind: "cashapp", label: "Cash App", sublabel: "Send from Cash App" },
  { kind: "zelle", label: "Zelle", sublabel: "Send from your bank's app" },
];

const APP_NAMES: Record<ManualPayMethod, string> = { cashapp: "Cash App", zelle: "Zelle" };

const isManual = (kind: PaymentMethodKind): kind is ManualPayMethod => kind === "cashapp" || kind === "zelle";
const isCard = (kind: PaymentMethodKind) => kind === "card" || kind === "wallet";

/** An API error in the portal's words; anything else (Stripe.js, the card form) already speaks for itself. */
const describe = (caught: unknown) => (caught instanceof ApiError || !(caught instanceof Error) ? messageFor(caught) : caught.message);

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
  // A card payment the bank is still checking (or Stripe is still processing).
  const [processing, setProcessing] = useState(false);
  const {
    tenant, currentBalance, payLimits, bankAccounts, plaidEnabled, testPayments, payOptions, reportedPayments,
    cardsEnabled, stripePublishableKey, cardFee, refresh,
  } = useTenantData();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept until this checkout succeeds: pressing Pay again (or a retry) reuses it.
  const [checkoutKey, setCheckoutKey] = useState(newCheckoutKey);
  const cardForm = useRef<CardFormHandle>(null);
  // Whether this device can show Apple Pay / Google Pay (null: still checking).
  const [walletAvailable, setWalletAvailable] = useState<boolean | null>(null);

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
  // Cards pass on the processor's fee (the server works out the same figure and charges that);
  // bank transfers, Cash App and Zelle have none.
  const rate = isCard(selectedMethod) ? cardFee : null;
  const fee = valid && amount !== null && rate ? processingFee(amount, rate) : 0;
  const total = valid && amount !== null ? round2(amount + fee) : 0;
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

  // A checkout is for one amount: when what will be charged changes, the next Pay is a new checkout.
  const checkoutTotal = useRef(total);
  useEffect(() => {
    if (checkoutTotal.current !== total) {
      checkoutTotal.current = total;
      setCheckoutKey(newCheckoutKey());
    }
  }, [total]);

  // Cash App / Zelle (012, 013): a screenshot of the payment goes with "I've sent it", and its
  // confirmation number when the tenant has it (the office can make the number required).
  const [transactionRef, setTransactionRef] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);
  const proofInput = useRef<HTMLInputElement>(null);

  const manual = isManual(selectedMethod) ? selectedMethod : null;
  // The office's own details for Cash App / Zelle (Settings on the manager side). Zelle can have an email, a phone number or both.
  const handlesFor = (method: ManualPayMethod): Array<{ label: string; value: string }> =>
    (method === "cashapp"
      ? [{ label: "Send to", value: payOptions.cashapp }]
      : [
          { label: "Zelle email", value: payOptions.zelle },
          { label: "Zelle phone number", value: payOptions.zellePhone },
        ]
    ).filter((h): h is { label: string; value: string } => Boolean(h.value));
  const sendTo = manual ? { app: APP_NAMES[manual], handles: handlesFor(manual) } : null;
  const offered = Boolean(sendTo && sendTo.handles.length > 0);
  const qrAt = manual === "cashapp" ? payOptions.cashappQrAt : manual === "zelle" ? payOptions.zelleQrAt : null;
  // Goes in the memo so the office can match the payment to the tenant.
  const reference = `${tenant.unitLabel} - ${tenant.name}`;
  // One payment at a time: a Cash App / Zelle report waiting for the office.
  const waiting = reportedPayments.find((r) => r.status === "pending") ?? null;
  const lastDecision = reportedPayments.find((r) => r.status !== "pending") ?? null;

  const bankAccount = bankAccounts[0] ?? null;
  const needsBankLink = selectedMethod === "bank" && plaidEnabled && !bankAccount;
  const unavailable = selectedMethod === "bank" && !plaidEnabled && !testPayments;
  const cardsReady = cardsEnabled && Boolean(stripePublishableKey);
  const refRequired = payOptions.requirePaymentRef;
  const proofReady = proofFile !== null && (!refRequired || transactionRef.trim() !== "");
  const canPay =
    valid &&
    !waiting &&
    (selectedMethod === "bank"
      ? !needsBankLink && !unavailable
      : selectedMethod === "card"
        ? cardsReady
        : offered && proofReady);
  // Apple Pay / Google Pay bring their own button, shown only when a payment can go through.
  const walletReady = selectedMethod === "wallet" && cardsReady && valid && !waiting;

  function clearProof() {
    setTransactionRef("");
    setProofFile(null);
    if (proofInput.current) proofInput.current.value = "";
  }

  function selectMethod(kind: PaymentMethodKind) {
    if (kind !== selectedMethod) clearProof(); // a Cash App screenshot is not proof of a Zelle payment
    setSelectedMethod(kind);
    setPaidJustNow(false);
    setProcessing(false);
    setError(null);
  }

  function start() {
    setIsSubmitting(true);
    setPaidJustNow(false);
    setProcessing(false);
    setError(null);
  }

  function finish(result: { confirmation: string }) {
    setConfirmation(result.confirmation);
    setPaidJustNow(true);
    setCheckoutKey(newCheckoutKey()); // the next payment is a new checkout
    setAmountText(null); // back to the suggested amount for the new balance
    clearProof();
    return refresh();
  }

  /** Show how a card payment ended up: after the charge, after a bank check, or after coming back from a redirect. */
  async function settleCard(paymentIntentId: string) {
    const result = await tenantApi.refreshCardPayment(paymentIntentId);
    if (result.status === "completed") return finish(result);
    setCheckoutKey(newCheckoutKey()); // a card's next try is a new checkout
    if (result.status === "failed") setError("That payment was canceled. You can try again.");
    else setProcessing(true);
    await refresh();
  }

  // Back from a bank's card check that left this site: finish that payment.
  useEffect(() => {
    const returned = takeStripeReturn();
    if (!returned) return;
    setSelectedMethod("card");
    start();
    settleCard(returned)
      .catch((caught) => setError(messageFor(caught)))
      .finally(() => setIsSubmitting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A card, Apple Pay or Google Pay token from Stripe.js: the server charges it (rent + fee) at once. */
  async function payWithCardToken(confirmationTokenId: string) {
    // The rent being paid; the server adds the processing fee to what the card is charged.
    const result = await tenantApi.payCard(amount!, checkoutKey, confirmationTokenId);
    if (result.requiresAction) {
      // The bank wants the cardholder to confirm (3-D Secure): Stripe shows its check.
      const stripe = await stripeClient(stripePublishableKey!);
      const checked = await stripe?.handleNextAction({ clientSecret: result.clientSecret });
      if (!checked || checked.error) {
        setCheckoutKey(newCheckoutKey());
        throw new Error(checked?.error?.message ?? "Your bank could not confirm the payment. Please try again.");
      }
    }
    await settleCard(result.paymentIntentId);
  }

  function handlePay() {
    start();
    const request =
      selectedMethod === "card"
        ? (async () => payWithCardToken(await cardForm.current!.createToken()))()
        : manual
          ? (async () => {
              // "I've sent it", with the screenshot and (when given) the confirmation number.
              if (!proofFile) throw new Error("Attach a screenshot of the payment first.");
              const evidence = { transactionRef: transactionRef.trim() || null, proof: await readPhoto(proofFile) };
              return finish(await tenantApi.reportPayment(manual, total, checkoutKey, evidence));
            })()
          : tenantApi.pay(total, bankAccount?.id ?? null, checkoutKey).then(finish);
    request
      .catch(async (caught) => {
        setError(describe(caught));
        await refresh(); // e.g. the balance changed, or a report is already waiting
      })
      .finally(() => setIsSubmitting(false));
  }

  /** The tenant confirmed in the Apple Pay / Google Pay sheet. Throwing tells the sheet it failed. */
  async function handleWalletToken(confirmationTokenId: string) {
    start();
    try {
      await payWithCardToken(confirmationTokenId);
    } catch (caught) {
      setError(describe(caught));
      await refresh();
      throw caught;
    } finally {
      setIsSubmitting(false);
    }
  }

  function sublabelFor(option: PaymentMethodOption): string {
    if (isManual(option.kind)) return handlesFor(option.kind).length > 0 ? option.sublabel : "Not offered right now";
    if (isCard(option.kind)) {
      if (!cardsEnabled) return "Not available yet";
      return `${option.sublabel} · ${cardFee ? `${describeRate(cardFee)} fee` : "No fee"}`;
    }
    return option.sublabel;
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
                <span className="method-sublabel">{sublabelFor(option)}</span>
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

        {selectedMethod === "card" && cardsReady && (
          <>
            <p className="method-note">Your card details go straight to Stripe, our payment processor. They are never stored here.</p>
            <CardPayment ref={cardForm} mode="card" publishableKey={stripePublishableKey!} amountCents={Math.round(Math.max(total, 0.5) * 100)} />
          </>
        )}
        {selectedMethod === "wallet" && cardsReady && (
          <p className="method-note">
            {walletAvailable === false
              ? "Apple Pay and Google Pay aren't available on this device or browser. Try Safari on an iPhone or Mac with Apple Pay set up, or Chrome with Google Pay, or pay by card."
              : "Press the Apple Pay or Google Pay button to pay with the card in your wallet."}
          </p>
        )}
        {isCard(selectedMethod) && !cardsReady && (
          <p className="method-note">Card payments aren't available right now. Please use a bank account, or Cash App or Zelle.</p>
        )}

        {sendTo &&
          (manual && offered ? (
            <>
              <ManualPayInstructions
                app={sendTo.app}
                handles={sendTo.handles}
                amount={valid ? formatCurrency(total) : "Enter the amount first"}
                reference={reference}
                qrUrl={qrAt ? tenantApi.qrUrl(manual, qrAt) : null}
              />
              <div className="manual-pay">
                <p className="manual-pay-title">After you pay, show the office</p>
                <label className="field-label" htmlFor="pay-proof">
                  Screenshot of the payment (required)
                </label>
                <input
                  id="pay-proof"
                  ref={proofInput}
                  className="field-input"
                  type="file"
                  accept={PHOTO_ACCEPT}
                  aria-required="true"
                  onChange={(e) => setProofFile(e.target.files?.[0] ?? null)}
                />
                <div className="field-hint">JPEG, PNG or WebP, up to 5 MB. The office checks it before your payment counts.</div>
                <label className="field-label" htmlFor="pay-ref" style={{ marginTop: 12 }}>
                  Confirmation number ({refRequired ? "required" : "recommended"})
                </label>
                <input
                  id="pay-ref"
                  className="field-input"
                  maxLength={120}
                  autoComplete="off"
                  aria-required={refRequired}
                  placeholder={manual === "cashapp" ? "#D1AB2C3" : "The confirmation number from your bank"}
                  value={transactionRef}
                  onChange={(e) => setTransactionRef(e.target.value)}
                />
                <div className="field-hint">
                  {manual === "cashapp"
                    ? "In Cash App, open the payment from your Activity. The identifier is at the bottom of the receipt."
                    : "Your bank's app shows a confirmation number once the Zelle payment is sent."}
                  {refRequired ? "" : " It helps the office find your payment faster."}
                </div>
              </div>
            </>
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
          <span>{formatCurrency(fee)}</span>
        </div>
        {rate && (
          <p className="summary-fee-note">
            Card payments cost {describeRate(rate)} per payment. It's added here so your full rent reaches the office. Bank transfers have no fee.
          </p>
        )}
        <div className="summary-row summary-row--total">
          <span>Total</span>
          <span>{formatCurrency(total)}</span>
        </div>

        {selectedMethod === "wallet" ? (
          walletReady ? (
            // Pressing Apple Pay / Google Pay opens the wallet sheet; confirming it pays.
            <div style={{ marginTop: 16, opacity: isSubmitting ? 0.6 : 1, pointerEvents: isSubmitting ? "none" : undefined }}>
              <CardPayment
                mode="wallet"
                publishableKey={stripePublishableKey!}
                amountCents={Math.round(total * 100)}
                onWalletToken={handleWalletToken}
                onWalletAvailability={setWalletAvailable}
              />
              {isSubmitting && <p className="method-note">Processing...</p>}
            </div>
          ) : (
            <button type="button" className="btn btn--primary" style={{ width: "100%", marginTop: 16 }} disabled>
              {`Pay ${formatCurrency(total)}`}
            </button>
          )
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            style={{ width: "100%", marginTop: 16 }}
            onClick={handlePay}
            disabled={isSubmitting || !canPay}
          >
            {isSubmitting ? "Processing..." : sendTo ? `I've sent ${formatCurrency(total)}` : `Pay ${formatCurrency(total)}`}
          </button>
        )}

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
        {processing && (
          <div className="pay-pending-banner" role="status">
            Your card payment is not finished yet. It shows in your ledger as soon as your card's bank confirms it.
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
  /** Where to send it: the $cashtag, or the Zelle email and / or phone number. */
  handles: Array<{ label: string; value: string }>;
  amount: string;
  reference: string;
  /** 012, 013: the office's QR code to scan; null when there is none. */
  qrUrl: string | null;
}

// Steps for paying by Cash App or Zelle, with copy buttons for the details (Juan's design).
function ManualPayInstructions({ app, handles, amount, reference, qrUrl }: ManualPayInstructionsProps) {
  return (
    <div className="manual-pay">
      <p className="manual-pay-title">Pay with {app}</p>
      {qrUrl && (
        <figure className="manual-pay-qr">
          <img src={qrUrl} alt={`The office's ${app} QR code`} />
          <figcaption>Scan with your phone's camera or in {app} to pay the office. Or copy the details below.</figcaption>
        </figure>
      )}
      {handles.map((h) => (
        <CopyRow key={h.label} label={h.label} value={h.value} />
      ))}
      <CopyRow label="Amount" value={amount} />
      <CopyRow label="Note / memo" value={reference} />
      <p className="method-note">
        Send exactly this amount in {app} with the note above, attach a screenshot of the payment below, then tap "I've sent" so the office can match it.
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
