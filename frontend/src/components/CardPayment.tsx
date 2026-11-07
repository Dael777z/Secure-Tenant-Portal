// Debit/credit cards, Apple Pay and Google Pay, through Stripe Elements. The card is
// typed into Stripe's own form (or chosen in the phone's wallet sheet): its number
// never reaches this site. What comes out is a ConfirmationToken, which the server
// reads and charges (src/services/stripe-payments.ts: startCard).
//
//   mode "card"    Stripe's card form; the page's own Pay button calls `createToken`
//   mode "wallet"  the Apple Pay / Google Pay button(s) the device supports; pressing one
//                  opens the wallet sheet, and confirming it calls `onWalletToken`
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { Appearance, StripeElements } from "@stripe/stripe-js";
import { stripeClient, stripeReturnUrl } from "./stripeClient";

export interface CardFormHandle {
  /** Check the form and turn it into a ConfirmationToken id (ctoken_...). Throws Stripe's message when the card details are incomplete. */
  createToken(): Promise<string>;
}

interface Props {
  mode: "card" | "wallet";
  publishableKey: string;
  /** What will be charged, rent + any fee, in cents (the wallet sheet shows it). */
  amountCents: number;
  /** Wallet mode: the tenant confirmed in Apple Pay / Google Pay. Throw to tell the sheet it failed. */
  onWalletToken?: (confirmationTokenId: string) => Promise<void>;
  /** Wallet mode: whether this device/browser can show Apple Pay or Google Pay. */
  onWalletAvailability?: (available: boolean) => void;
  ref?: Ref<CardFormHandle>;
}

/** Stripe's form in the portal's own colours (theme/theme.css), light or dark, whichever is showing. */
function portalAppearance(): Appearance {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const surface = token("--s-surface", "#ffffff");
  return {
    theme: isDark(surface) ? "night" : "stripe",
    variables: {
      colorPrimary: token("--s-primary", "#2f5d8a"),
      colorBackground: surface,
      colorText: token("--s-text", "#141a22"),
      colorDanger: token("--s-danger", "#b23a3a"),
      fontFamily: "Inter, -apple-system, Segoe UI, sans-serif",
      borderRadius: "8px",
    },
  };
}

/** A #rrggbb (or #rgb) colour that is darker than mid-grey. Anything else counts as light. */
function isDark(color: string): boolean {
  const hex = color.replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(full)) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.299 * r! + 0.587 * g! + 0.114 * b! < 128;
}

export function CardPayment({ mode, publishableKey, amountCents, onWalletToken, onWalletAvailability, ref }: Props) {
  const mount = useRef<HTMLDivElement>(null);
  const elementsRef = useRef<StripeElements | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // The latest callbacks, without re-creating Stripe's element when they change.
  const walletToken = useRef(onWalletToken);
  walletToken.current = onWalletToken;
  const availability = useRef(onWalletAvailability);
  availability.current = onWalletAvailability;

  async function tokenFrom(elements: StripeElements): Promise<string> {
    const stripe = await stripeClient(publishableKey);
    if (!stripe) throw new Error("Card payments could not load. Check your connection and try again.");
    const submitted = await elements.submit();
    if (submitted.error) throw new Error(submitted.error.message ?? "Check your card details.");
    const { confirmationToken, error } = await stripe.createConfirmationToken({ elements, params: { return_url: stripeReturnUrl() } });
    if (error || !confirmationToken) throw new Error(error?.message ?? "Your card could not be read. Please try again.");
    return confirmationToken.id;
  }

  useImperativeHandle(ref, () => ({
    createToken: () => {
      if (!elementsRef.current) return Promise.reject(new Error("The card form is still loading."));
      return tokenFrom(elementsRef.current);
    },
  }));

  // Build Stripe's element once per mode; the amount is updated below.
  useEffect(() => {
    let cancelled = false;
    let destroy = () => {};
    void stripeClient(publishableKey).then((stripe) => {
      if (cancelled || !mount.current) return;
      if (!stripe) {
        setFailed("Card payments could not load. Check your connection and try again.");
        availability.current?.(false);
        return;
      }
      const elements = stripe.elements({
        mode: "payment", amount: amountCents, currency: "usd", allowedPaymentMethodTypes: ["card"], appearance: portalAppearance(),
      });
      elementsRef.current = elements;
      if (mode === "card") {
        // Only the card form: Apple Pay and Google Pay have their own option.
        const card = elements.create("payment", { layout: "tabs", wallets: { applePay: "never", googlePay: "never", link: "never" } });
        card.mount(mount.current);
        destroy = () => card.destroy();
      } else {
        const wallet = elements.create("expressCheckout", {
          paymentMethods: { applePay: "always", googlePay: "always", link: "never", paypal: "never", amazonPay: "never", klarna: "never" },
          buttonHeight: 44,
        });
        wallet.on("ready", (event) => availability.current?.(Boolean(event.availablePaymentMethods)));
        wallet.on("confirm", async (event) => {
          try {
            await walletToken.current?.(await tokenFrom(elements));
          } catch {
            event.paymentFailed({ reason: "fail" });
          }
        });
        wallet.mount(mount.current);
        destroy = () => wallet.destroy();
      }
    });
    return () => {
      cancelled = true;
      destroy();
      elementsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, publishableKey]);

  useEffect(() => {
    elementsRef.current?.update({ amount: amountCents });
  }, [amountCents]);

  // Follow the theme switch (Settings) and the device's light/dark setting.
  useEffect(() => {
    const restyle = () => elementsRef.current?.update({ appearance: portalAppearance() });
    const observer = new MutationObserver(restyle);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener("change", restyle);
    return () => {
      observer.disconnect();
      media?.removeEventListener("change", restyle);
    };
  }, []);

  return (
    <div className="card-payment">
      <div ref={mount} />
      {failed && <p className="method-note">{failed}</p>}
    </div>
  );
}
