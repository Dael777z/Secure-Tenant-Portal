/** Download rows as a CSV file the office can open in Excel or Google Sheets. */
export function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const cell = (v: string | number) => {
    const s = String(v);
    // Quote anything with a comma, quote or newline; neutralise spreadsheet formulas.
    const safe = /^[=+\-@]/.test(s) && typeof v === "string" ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const text = rows.map((r) => r.map(cell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
