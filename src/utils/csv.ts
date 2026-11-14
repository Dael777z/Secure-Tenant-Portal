/**
 * CSV for the report downloads. A byte-order mark first so Excel reads UTF-8,
 * CRLF line ends, and a cell is quoted when it holds a comma, quote or line
 * break. A cell starting with = + - @ gets a leading apostrophe, so a name like
 * "=HYPERLINK(...)" is shown as text instead of run as a formula.
 */
export type CsvCell = string | number | boolean | null | undefined

function cell(value: CsvCell): string {
    if (value === null || value === undefined) return ""
    let text = typeof value === "boolean" ? (value ? "yes" : "no") : String(value)
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
    return "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"
}

/** Dollars with two decimals, for spreadsheets (no $ or commas). */
export const csvMoney = (value: number | null | undefined): string => (value === null || value === undefined ? "" : (Math.round(value * 100) / 100).toFixed(2))
