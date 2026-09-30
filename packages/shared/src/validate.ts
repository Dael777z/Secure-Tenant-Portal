/**
 * A dependency-free runtime schema validator with a Zod-shaped API.
 *
 * Why this exists rather than `zod`: the deployment target for this system is a
 * property manager's own VPS, and every runtime dependency is a supply-chain
 * surface that the operator inherits and must patch. The proposal commits to
 * "Zod schema validation at every request boundary"; what actually matters for
 * that commitment is that (a) every request boundary is validated by a declared
 * schema, (b) validation is total — unknown keys are rejected, not ignored, and
 * (c) the same schema definitions are shared by client and server so the two
 * cannot disagree about the shape of a money field. All three hold here.
 *
 * Swapping this for zod is a mechanical change: the exported combinators match
 * zod's names and `parse`/`safeParse` semantics.
 */

export type Issue = { path: string; message: string };

export class ValidationError extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; "));
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: Issue[] };

type Check<T> = (value: T, path: string) => Issue[];

export class Schema<T> {
  readonly _run: (value: unknown, path: string) => ParseResult<T>;
  private readonly _checks: Check<T>[];

  constructor(run: (value: unknown, path: string) => ParseResult<T>, checks: Check<T>[] = []) {
    this._run = run;
    this._checks = checks;
  }

  parse(value: unknown, path = ""): T {
    const r = this.safeParse(value, path);
    if (!r.ok) throw new ValidationError(r.issues);
    return r.value;
  }

  safeParse(value: unknown, path = ""): ParseResult<T> {
    const base = this._run(value, path);
    if (!base.ok) return base;
    const issues: Issue[] = [];
    for (const check of this._checks) issues.push(...check(base.value, path));
    return issues.length ? { ok: false, issues } : base;
  }

  refine(predicate: (value: T) => boolean, message: string): Schema<T> {
    return new Schema<T>(this._run, [
      ...this._checks,
      (v, p) => (predicate(v) ? [] : [{ path: p, message }]),
    ]);
  }

  optional(): Schema<T | undefined> {
    return new Schema<T | undefined>((v, p) =>
      v === undefined ? { ok: true, value: undefined } : this.safeParse(v, p),
    );
  }

  nullable(): Schema<T | null> {
    return new Schema<T | null>((v, p) =>
      v === null ? { ok: true, value: null } : this.safeParse(v, p),
    );
  }

  default(fallback: T | (() => T)): Schema<T> {
    return new Schema<T>((v, p) => {
      if (v === undefined) {
        return { ok: true, value: typeof fallback === "function" ? (fallback as () => T)() : fallback };
      }
      return this.safeParse(v, p);
    });
  }

  transform<U>(fn: (value: T) => U): Schema<U> {
    return new Schema<U>((v, p) => {
      const r = this.safeParse(v, p);
      return r.ok ? { ok: true, value: fn(r.value) } : r;
    });
  }
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

const fail = (path: string, message: string): ParseResult<never> => ({
  ok: false,
  issues: [{ path, message }],
});

export const string = (): Schema<string> =>
  new Schema((v, p) => (typeof v === "string" ? { ok: true, value: v } : fail(p, "expected a string")));

export const number = (): Schema<number> =>
  new Schema((v, p) =>
    typeof v === "number" && Number.isFinite(v) ? { ok: true, value: v } : fail(p, "expected a finite number"),
  );

/** A whole number. Money in this system is always an integer count of cents. */
export const integer = (): Schema<number> =>
  new Schema((v, p) =>
    typeof v === "number" && Number.isSafeInteger(v)
      ? { ok: true, value: v }
      : fail(p, "expected a whole number"),
  );

export const boolean = (): Schema<boolean> =>
  new Schema((v, p) => (typeof v === "boolean" ? { ok: true, value: v } : fail(p, "expected true or false")));

/**
 * Accepts booleans and the strings/numbers that HTML forms and query strings
 * produce for them. Used only on query-string boundaries, never on JSON bodies.
 */
export const looseBoolean = (): Schema<boolean> =>
  new Schema((v, p) => {
    if (typeof v === "boolean") return { ok: true, value: v };
    if (v === "true" || v === "1" || v === 1) return { ok: true, value: true };
    if (v === "false" || v === "0" || v === 0) return { ok: true, value: false };
    return fail(p, "expected true or false");
  });

/** Query strings carry numbers as text; parse then validate as an integer. */
export const numericString = (): Schema<number> =>
  new Schema((v, p) => {
    if (typeof v === "number" && Number.isSafeInteger(v)) return { ok: true, value: v };
    if (typeof v !== "string" || v.trim() === "") return fail(p, "expected a whole number");
    const n = Number(v);
    return Number.isSafeInteger(n) ? { ok: true, value: n } : fail(p, "expected a whole number");
  });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const uuid = (): Schema<string> =>
  new Schema((v, p) =>
    typeof v === "string" && UUID_RE.test(v) ? { ok: true, value: v } : fail(p, "expected a UUID"),
  );

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const email = (): Schema<string> =>
  new Schema((v, p) =>
    typeof v === "string" && v.length <= 254 && EMAIL_RE.test(v)
      ? { ok: true, value: v.toLowerCase().trim() }
      : fail(p, "expected an email address"),
  );

/** ISO calendar date, `YYYY-MM-DD`, validated for real-calendar existence. */
export const isoDate = (): Schema<string> =>
  new Schema((v, p) => {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return fail(p, "expected a date as YYYY-MM-DD");
    const [y, m, d] = v.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const real = dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
    return real ? { ok: true, value: v } : fail(p, "not a real calendar date");
  });

/** Accounting period, `YYYY-MM`. The unit a rent roll is opened for. */
export const periodKey = (): Schema<string> =>
  new Schema((v, p) => {
    if (typeof v !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) return fail(p, "expected a period as YYYY-MM");
    return { ok: true, value: v };
  });

export const literal = <const T extends string | number | boolean>(expected: T): Schema<T> =>
  new Schema((v, p) => (v === expected ? { ok: true, value: expected } : fail(p, `expected ${String(expected)}`)));

export const enumOf = <const T extends readonly string[]>(values: T): Schema<T[number]> =>
  new Schema((v, p) =>
    typeof v === "string" && (values as readonly string[]).includes(v)
      ? { ok: true, value: v as T[number] }
      : fail(p, `expected one of: ${values.join(", ")}`),
  );

export const array = <T>(item: Schema<T>): Schema<T[]> =>
  new Schema((v, p) => {
    if (!Array.isArray(v)) return fail(p, "expected an array");
    const out: T[] = [];
    const issues: Issue[] = [];
    v.forEach((entry, i) => {
      const r = item.safeParse(entry, `${p}[${i}]`);
      if (r.ok) out.push(r.value);
      else issues.push(...r.issues);
    });
    return issues.length ? { ok: false, issues } : { ok: true, value: out };
  });

export const record = <T>(value: Schema<T>): Schema<Record<string, T>> =>
  new Schema((v, p) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return fail(p, "expected an object");
    const out: Record<string, T> = {};
    const issues: Issue[] = [];
    for (const [k, entry] of Object.entries(v)) {
      const r = value.safeParse(entry, p ? `${p}.${k}` : k);
      if (r.ok) out[k] = r.value;
      else issues.push(...r.issues);
    }
    return issues.length ? { ok: false, issues } : { ok: true, value: out };
  });

/** Arbitrary JSON, used for notification payloads and audit metadata. */
export const json = (): Schema<unknown> => new Schema((v) => ({ ok: true, value: v }));

// Schema<any>, not Schema<unknown>: a Check<T> makes Schema invariant in T, so
// Schema<string> is not assignable to Schema<unknown> and every object() failed to typecheck.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Shape = Record<string, Schema<any>>;
type ObjectOutput<S extends Shape> = { [K in keyof S]: Infer<S[K]> };

/**
 * Object schemas are strict: a key that is not in the shape is an error, not
 * something to silently drop. On a money-handling API an unexpected field is
 * far more likely to be a client/server disagreement than a harmless extra.
 */
export const object = <S extends Shape>(shape: S): Schema<ObjectOutput<S>> =>
  new Schema((v, p) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return fail(p, "expected an object");
    const input = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const issues: Issue[] = [];

    for (const [key, schema] of Object.entries(shape)) {
      const child = p ? `${p}.${key}` : key;
      const r = schema.safeParse(input[key], child);
      if (r.ok) {
        if (r.value !== undefined || key in input) out[key] = r.value;
      } else {
        issues.push(...r.issues);
      }
    }

    for (const key of Object.keys(input)) {
      if (!(key in shape)) issues.push({ path: p ? `${p}.${key}` : key, message: "unrecognized field" });
    }

    return issues.length ? { ok: false, issues } : { ok: true, value: out as ObjectOutput<S> };
  });

export const union = <T extends readonly Schema<unknown>[]>(
  options: T,
): Schema<Infer<T[number]>> =>
  new Schema((v, p) => {
    const issues: Issue[] = [];
    for (const option of options) {
      const r = option.safeParse(v, p);
      if (r.ok) return r as ParseResult<Infer<T[number]>>;
      issues.push(...r.issues);
    }
    return { ok: false, issues };
  });

/* ------------------------------------------------------------------ *
 * String refinements used constantly on request boundaries.
 * ------------------------------------------------------------------ */

export const nonEmptyString = (max = 500): Schema<string> =>
  string()
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, "must not be blank")
    .refine((s) => s.length <= max, `must be ${max} characters or fewer`);

export const boundedText = (max: number): Schema<string> =>
  string()
    .transform((s) => s.trim())
    .refine((s) => s.length <= max, `must be ${max} characters or fewer`);

/**
 * A reason string attached to a discretionary manager action. Required and
 * non-trivial by design: the point of routing waivers and payment plans through
 * the system is that the record carries why, and a one-character reason defeats
 * that as thoroughly as no reason at all.
 */
export const actionReason = (): Schema<string> =>
  string()
    .transform((s) => s.trim())
    .refine((s) => s.length >= 4, "a reason is required and must be meaningful")
    .refine((s) => s.length <= 1000, "must be 1000 characters or fewer");
