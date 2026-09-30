/**
 * Plaid, for bank account verification.
 *
 * Plaid's role here is narrow and worth stating: it proves that the person
 * adding a bank account can actually authenticate to it, and hands back a
 * processor token that Stripe accepts. It does not move money and it is not
 * required — Stripe's own micro-deposit flow reaches the same place more slowly,
 * and an operator who would rather not add a second vendor can leave
 * PLAID_CLIENT_ID unset and use it.
 *
 * We keep no Plaid access token beyond the exchange. The public token becomes a
 * processor token, the processor token becomes a Stripe payment method, and
 * nothing that could be used to read a resident's bank transactions is retained.
 * Given what the literature documents about rental-housing platforms
 * accumulating financial data on residents, holding that access would be
 * indefensible for a system whose whole argument is that it does not.
 */

const ENVIRONMENTS: Record<string, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export interface PlaidOptions {
  clientId: string;
  secret: string;
  environment: string;
}

export interface LinkTokenResult {
  linkToken: string;
  expiration: string;
}

export class PlaidClient {
  private readonly options: PlaidOptions;
  private readonly baseUrl: string;

  constructor(options: PlaidOptions) {
    this.options = options;
    this.baseUrl = ENVIRONMENTS[options.environment] ?? ENVIRONMENTS.sandbox;
  }

  get configured(): boolean {
    return Boolean(this.options.clientId && this.options.secret);
  }

  /** A short-lived token the browser hands to Plaid Link to open the flow. */
  async createLinkToken(userId: string, residentName: string): Promise<LinkTokenResult> {
    const response = await this.request("/link/token/create", {
      client_name: "Summit",
      language: "en",
      country_codes: ["US"],
      // Opaque and stable: Plaid receives an identifier, not an identity.
      user: { client_user_id: userId },
      products: ["auth"],
      account_filters: { depository: { account_subtypes: ["checking", "savings"] } },
    });
    return {
      linkToken: String(response.link_token),
      expiration: String(response.expiration),
    };
  }

  /**
   * Exchange the public token from Link for a Stripe processor token.
   *
   * The intermediate access token is used once, here, and never stored. That is
   * a deliberate limitation of what this deployment can ever do with a
   * resident's bank connection.
   */
  async exchangeForStripeToken(publicToken: string, accountId: string): Promise<string> {
    const exchange = await this.request("/item/public_token/exchange", {
      public_token: publicToken,
    });
    const accessToken = String(exchange.access_token);

    const processor = await this.request("/processor/stripe/bank_account_token/create", {
      access_token: accessToken,
      account_id: accountId,
    });

    // Drop the item entirely: the verification is done, and continued access
    // would let this system read transactions it has no business reading.
    await this.request("/item/remove", { access_token: accessToken }).catch(() => {});

    return String(processor.stripe_bank_account_token);
  }

  async accountsFor(publicToken: string): Promise<Array<{ id: string; name: string; mask: string }>> {
    const exchange = await this.request("/item/public_token/exchange", { public_token: publicToken });
    const accounts = await this.request("/accounts/get", { access_token: String(exchange.access_token) });
    const list = (accounts.accounts ?? []) as Array<Record<string, unknown>>;
    return list.map((account) => ({
      id: String(account.account_id),
      name: String(account.name ?? "Account"),
      mask: String(account.mask ?? ""),
    }));
  }

  private async request(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.options.clientId,
        secret: this.options.secret,
        ...body,
      }),
    });

    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        `Plaid ${path} failed: ${String(payload.error_message ?? payload.error_code ?? response.status)}`,
      );
    }
    return payload;
  }
}
