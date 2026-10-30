// Cash App Pay through Stripe.js. On a computer Stripe shows a QR code to scan with
// the Cash App on a phone; on a phone it opens Cash App, which sends the tenant back
// to this site with ?payment_intent=pi_...&redirect_status=... on the address.
import { loadStripe, type Stripe } from "@stripe/stripe-js";

let stripe: Promise<Stripe | null> | null = null;

/** True when Cash App just sent the tenant back here: finish the payment on the pay page. */
export function isCashAppReturn(): boolean {
  const params = new URLSearchParams(window.location.search);
  return /^pi_/.test(params.get("payment_intent") ?? "") && params.has("redirect_status");
}

/** The PaymentIntent Cash App sent the tenant back with, and a clean address again. */
export function takeCashAppReturn(): string | null {
  if (!isCashAppReturn()) return null;
  const id = new URLSearchParams(window.location.search).get("payment_intent");
  window.history.replaceState(null, "", window.location.pathname);
  return id;
}

/**
 * Show Cash App Pay for this checkout. Resolves once the tenant finishes, cancels or closes it
 * (on a phone the page usually navigates to Cash App instead, and comes back via isCashAppReturn).
 */
export async function confirmWithCashApp(publishableKey: string, clientSecret: string): Promise<{ paymentIntentId: string | null; error: string | null }> {
  stripe ??= loadStripe(publishableKey);
  const client = await stripe;
  if (!client) return { paymentIntentId: null, error: "Cash App Pay could not load. Check your connection and try again." };
  const { paymentIntent, error } = await client.confirmCashappPayment(clientSecret, {
    payment_method: {},
    return_url: `${window.location.origin}/`,
  });
  if (error) return { paymentIntentId: error.payment_intent?.id ?? null, error: error.message ?? "Cash App Pay did not go through." };
  return { paymentIntentId: paymentIntent?.id ?? null, error: null };
}
