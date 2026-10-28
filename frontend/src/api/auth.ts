// Talks to the backend's /api/auth routes (src/routes/auth.ts). The session
// lives in httpOnly cookies the server sets, so nothing is stored here.

export interface SessionUser {
  user_id: string;
  email?: string;
  role: "tenant" | "property_manager" | "maintenance_staff" | "platform_admin";
  permissions: string[];
}

export class AuthError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
  }
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function errorFrom(res: Response): Promise<AuthError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new AuthError(body.error ?? "UNKNOWN", res.status);
}

export async function login(email: string, password: string): Promise<SessionUser> {
  const res = await call("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  if (!res.ok) throw await errorFrom(res);
  return ((await res.json()) as { user: SessionUser }).user;
}

/**
 * Who is signed in, or null. The access cookie lasts 15 minutes; when it has
 * expired this trades the refresh cookie for a new pair once and asks again.
 */
export async function currentUser(): Promise<SessionUser | null> {
  let res = await call("/auth/me");
  if (res.status === 401) {
    const refreshed = await call("/auth/refresh", { method: "POST" });
    if (!refreshed.ok) return null;
    res = await call("/auth/me");
  }
  if (!res.ok) return null;
  return ((await res.json()) as { user: SessionUser }).user;
}

export async function logout(): Promise<void> {
  await call("/auth/logout", { method: "POST" });
}

/** Words for the sign-in form. Never says whether the email has an account. */
export function loginMessage(error: unknown): string {
  if (error instanceof AuthError) {
    if (error.code === "INVALID_CREDENTIALS") return "That email and password do not match.";
    if (error.status === 403) return "This page could not be verified. Reload it and try again.";
    if (error.status === 400) return "Enter your email and password.";
  }
  return "We could not reach the server. Check your connection and try again.";
}
