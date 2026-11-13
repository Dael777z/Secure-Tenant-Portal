// Stripe.js, loaded once, and the way back from a Stripe redirect. The occasional bank check
// on a card (3-D Secure) leaves this site and comes back with
// ?payment_intent=pi_...&redirect_status=... on the address.
import { loadStripe, type Stripe } from "@stripe/stripe-js";

let stripe: Promise<Stripe | null> | null = null;

export function stripeClient(publishableKey: string): Promise<Stripe | null> {
  stripe ??= loadStripe(publishableKey);
  return stripe;
}

/** Where Stripe sends the tenant back to after a redirect. */
export const stripeReturnUrl = () => `${window.location.origin}/`;

/** True when Stripe just sent the tenant back here: finish the payment on the pay page. */
export function isStripeReturn(): boolean {
  const params = new URLSearchParams(window.location.search);
  return /^pi_/.test(params.get("payment_intent") ?? "") && params.has("redirect_status");
}

/** The PaymentIntent Stripe sent the tenant back with, and a clean address again. */
export function takeStripeReturn(): string | null {
  if (!isStripeReturn()) return null;
  const id = new URLSearchParams(window.location.search).get("payment_intent");
  window.history.replaceState(null, "", window.location.pathname);
  return id;
}
