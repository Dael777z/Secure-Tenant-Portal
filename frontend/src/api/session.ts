// One fetch for every API call after sign-in (tenant and manager sides).
//
// The access cookie lasts 15 minutes. When a call comes back 401, this trades
// the refresh cookie for a new pair once and repeats the call, so a page left
// open does not start failing. Calls that fail at the same moment share one
// refresh: refresh tokens rotate, so a second refresh with the old cookie would
// be refused.
//
// A final 401 or 403 can also mean someone signed in as a different person in
// another tab (the cookies are shared). App.tsx listens for SESSION_CHECK and
// asks the server who is signed in now.

export const SESSION_CHECK = "portal:session-check";

let refreshing: Promise<boolean> | null = null;

function refreshOnce(): Promise<boolean> {
  refreshing ??= fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin" })
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const request = () =>
    fetch(url, {
      credentials: "same-origin",
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });

  let res = await request();
  if (res.status === 401 && (await refreshOnce())) res = await request();
  if (res.status === 401 || res.status === 403) window.dispatchEvent(new Event(SESSION_CHECK));
  return res;
}
