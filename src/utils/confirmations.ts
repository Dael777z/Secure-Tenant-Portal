import crypto from "crypto"

/**
 * Confirmation numbers become the payment's transaction_id (unique in the
 * database). The prefix says who recorded it: "OFF-" for the office, "CONF-"
 * for a tenant. Only office payments can be reversed, which is how the
 * reversal tells them apart.
 */
export const OFFICE_PAYMENT_PREFIX = "OFF-"
export const TENANT_PAYMENT_PREFIX = "CONF-"

const digits = () => crypto.randomInt(10_000_000, 99_999_999)

export const officeConfirmation = () => `${OFFICE_PAYMENT_PREFIX}${digits()}`
export const tenantConfirmation = () => `${TENANT_PAYMENT_PREFIX}${digits()}`
/** The correcting refund row that undoes office payment `payId`. */
export const reversalConfirmation = (payId: number) => `${OFFICE_PAYMENT_PREFIX}REV-${payId}`
