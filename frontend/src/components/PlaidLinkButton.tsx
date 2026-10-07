// Dael's "Connect bank account" (feature/plaid-connector, src/App.tsx), as a
// button for the Pay rent page: get a link token, open Plaid Link, hand the
// public token back to the server.
import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { messageFor, tenantApi } from "../api/tenant";

interface PlaidLinkButtonProps {
  onLinked: () => void;
}

export function PlaidLinkButton({ onLinked }: PlaidLinkButtonProps) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    tenantApi
      .createLinkToken()
      .then((data) => setLinkToken(data.link_token))
      .catch((caught) => setError(messageFor(caught)));
  }, []);

  const onSuccess = useCallback(
    async (publicToken: string | null) => {
      if (!publicToken) return;
      setLoading(true);
      setError(null);
      try {
        await tenantApi.exchangeAndGetAuth(publicToken);
        onLinked();
      } catch (caught) {
        setError(messageFor(caught));
      } finally {
        setLoading(false);
      }
    },
    [onLinked],
  );

  const { open, ready } = usePlaidLink({ token: linkToken, onSuccess });

  return (
    <div className="plaid-link">
      <button type="button" className="btn btn--outline" onClick={() => open()} disabled={!ready || loading}>
        {loading ? "Linking your bank…" : "Connect bank account"}
      </button>
      {error && <p className="plaid-link-error" role="alert">{error}</p>}
    </div>
  );
}
