/**
 * CSV reading for imports. RFC 4180: quoted fields, doubled quotes inside
 * them, commas and line breaks inside quotes, CRLF or LF line endings, and the
 * byte-order mark Excel puts at the front of a "CSV UTF-8" file.
 */

export interface CsvTable {
  header: string[];
  /** Each row keyed by normalized header name, with its 1-based line number in the sheet (header = 1). */
  rows: Array<{ line: number; values: Record<string, string> }>;
}

export function parseCsv(text: string): string[][] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      record.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      record.push(field);
      records.push(record);
      field = "";
      record = [];
      i += ch === "\r" && input[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // Blank lines (an empty trailing line, rows Excel left behind) are not rows.
  return records.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** "Unit Label" / "unit-label" / " UNIT_LABEL " all mean unit_label. */
export function normalizeHeader(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function readTable(text: string): CsvTable {
  const records = parseCsv(text);
  if (records.length === 0) return { header: [], rows: [] };
  const header = records[0]!.map(normalizeHeader);
  const rows = records.slice(1).map((cells, index) => {
    const values: Record<string, string> = {};
    header.forEach((name, column) => {
      if (name) values[name] = (cells[column] ?? "").trim();
    });
    return { line: index + 2, values };
  });
  return { header, rows };
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const text = cell === null || cell === undefined ? "" : String(cell);
          return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(","),
    )
    .join("\r\n");
}

/** "$1,234.50", "1234.5", "(45.00)" → cents. Null when it is not an amount. */
export function parseDollars(text: string): number | null {
  const raw = text.trim();
  if (!raw) return null;
  const negative = /^\(.*\)$/.test(raw) || raw.startsWith("-");
  const cleaned = raw.replace(/[()$,\s-]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return negative ? -cents : cents;
}

/** "2025-10-01", "10/1/2025", "10/01/25" → "2025-10-01". Null when it is not a date. */
export function parseDate(text: string): string | null {
  const raw = text.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (match) {
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  } else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(raw))) {
    [m, d, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (y < 100) y += 2000;
  } else {
    return null;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
