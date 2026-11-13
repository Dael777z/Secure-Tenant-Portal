// "Connect bank account" on the Pay rent page: get a link token from the
// server, open Plaid Link, and hand the public token back to the server.
//
// Banks that sign in on their own website (OAuth) send the tenant to
// /plaid-oauth?oauth_state_id=... afterwards. Link then has to be opened again
// with the same link token and that address, so the token is kept in
// sessionStorage while Link is open.
import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { messageFor, tenantApi } from "../api/tenant";

const TOKEN_KEY = "plaid_link_token";

/** True when this page load is the return from a bank's OAuth sign-in. */
export function isPlaidOAuthReturn(): boolean {
  return window.location.pathname === "/plaid-oauth" && new URLSearchParams(window.location.search).has("oauth_state_id");
}

interface PlaidLinkButtonProps {
  onLinked: () => void;
}

export function PlaidLinkButton({ onLinked }: PlaidLinkButtonProps) {
  // without the stored token (another tab, storage cleared) the oauth return cannot resume; start over
  const [returning] = useState(() => isPlaidOAuthReturn() && sessionStorage.getItem(TOKEN_KEY) !== null);
  const [linkToken, setLinkToken] = useState<string | null>(() => (returning ? sessionStorage.getItem(TOKEN_KEY) : null));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // a new link session, unless this is the return from oauth with the old token still stored
  useEffect(() => {
    if (linkToken) return;
    tenantApi
      .createLinkToken()
      .then((data) => {
        sessionStorage.setItem(TOKEN_KEY, data.link_token);
        setLinkToken(data.link_token);
      })
      .catch((caught) => setError(messageFor(caught)));
  }, [linkToken]);

  // link is finished either way: forget the token and leave the oauth address
  const finish = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    if (window.location.pathname === "/plaid-oauth") window.history.replaceState(null, "", "/");
  }, []);

  const onSuccess = useCallback(
    async (publicToken: string | null) => {
      finish();
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
    [onLinked, finish],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: finish,
    // the full return address, oauth_state_id included, lets link pick up where the bank left off
    receivedRedirectUri: returning ? window.location.href : undefined,
  });

  // back from oauth: reopen link straight away
  useEffect(() => {
    if (returning && ready) open();
  }, [returning, ready, open]);

  return (
    <div className="plaid-link">
      <button type="button" className="btn btn--outline" onClick={() => open()} disabled={!ready || loading}>
        {loading ? "Linking your bank…" : "Connect bank account"}
      </button>
      {error && <p className="plaid-link-error" role="alert">{error}</p>}
    </div>
  );
}
