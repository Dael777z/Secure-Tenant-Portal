/**
 * The error vocabulary.
 *
 * Error text in this system is written for the person who will read it, which
 * on the resident side is often somebody worried about their housing. "Request
 * failed" is not an acceptable message on a page about rent; every error below
 * says what happened and, where there is one, what to do next.
 *
 * The other rule is that errors must not become an information channel. A
 * request for a record belonging to somebody else and a request for a record
 * that does not exist produce the same 404 with the same body, because the
 * difference between them is exactly the fact an attacker is probing for.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: Array<{ path: string; message: string }>;
  readonly headers?: Record<string, string>;

  constructor(
    status: number,
    code: string,
    message: string,
    options: { issues?: Array<{ path: string; message: string }>; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.issues = options.issues;
    this.headers = options.headers;
  }
}

export const badRequest = (message: string, issues?: Array<{ path: string; message: string }>) =>
  new HttpError(400, "bad_request", message, { issues });

export const unauthorized = (message = "Please sign in to continue.") =>
  new HttpError(401, "unauthorized", message);

export const forbidden = (message = "You do not have access to that.") =>
  new HttpError(403, "forbidden", message);

/**
 * The single answer for both "no such record" and "not yours". Callers should
 * reach for this rather than `forbidden` whenever distinguishing the two would
 * tell the caller something about a record they cannot see.
 */
export const notFound = (message = "We could not find that.") =>
  new HttpError(404, "not_found", message);

export const conflict = (message: string) => new HttpError(409, "conflict", message);

export const unprocessable = (message: string, issues?: Array<{ path: string; message: string }>) =>
  new HttpError(422, "unprocessable", message, { issues });

export const tooManyRequests = (message: string, retryAfterSeconds: number) =>
  new HttpError(429, "too_many_requests", message, {
    headers: { "retry-after": String(retryAfterSeconds) },
  });

export const payloadTooLarge = (message: string) => new HttpError(413, "payload_too_large", message);

export const serverError = (message = "Something went wrong on our side. Nothing was changed.") =>
  new HttpError(500, "server_error", message);
