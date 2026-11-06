// Charts for the Finance, Profit & Loss and Performance screens. Plain SVG,
// no chart library: one money axis per chart, thin marks, a legend whenever
// there is more than one series, and a tooltip on hover or keyboard focus.
// Colours: income blue and expense orange (checked for colour-blind
// separation), status green/amber/red only for paid/open/late.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { money } from "./ui";

export const SERIES = { income: "#1560b8", expense: "#c8691f", net: "#17212b", billed: "#9db8d9" };
export const STATUS = { paid: "#11733d", open: "#b7791f", late: "#b42318" };
export const AGING = ["#e7c56a", "#d99a3d", "#c8691f", "#a63c1c"]; // 1–30 … 90+, light to dark

function useWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.max(260, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** A tidy gridline step (1, 2, 2.5 or 5 × a power of ten) giving about `count` steps over `span`. */
function niceStep(span: number, count = 4): number {
  const raw = Math.max(span, 1) / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

/** Axis ticks from `low` to `high` that always include zero, on round numbers. */
function moneyTicks(low: number, high: number): number[] {
  const step = niceStep(high - Math.min(0, low));
  const from = Math.min(0, Math.floor(low / step) * step);
  const to = Math.max(step, Math.ceil(high / step) * step);
  const out: number[] = [];
  for (let v = from; v <= to + step / 2; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

const short = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1_000_000 ? `${(a / 1_000_000).toFixed(1)}M` : a >= 1000 ? `${(a / 1000).toFixed(a >= 10_000 ? 0 : 1)}k` : `${Math.round(a)}`;
  return `${n < 0 ? "-" : ""}$${s.replace(".0k", "k")}`;
};

export function Legend({ items }: { items: Array<{ label: string; color: string; line?: boolean }> }) {
  return (
    <ul className="mgr-legend">
      {items.map((i) => (
        <li key={i.label}>
          <span className={`mgr-legend__swatch${i.line ? " mgr-legend__swatch--line" : ""}`} style={{ background: i.color }} aria-hidden="true" />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** Beside the hovered point (right of it, or left near the right edge), so it never hides the bars it describes. */
function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const right = x > width - 230;
  return (
    <div className="mgr-tooltip" role="status" style={right ? { right: width - x + 26, top: y } : { left: x + 26, top: y }}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Payments gauge: of everything due in the period, paid / open / late
 * ------------------------------------------------------------------ */

export function CollectionGauge({ paid, open, late }: { paid: number; open: number; late: number }) {
  const total = paid + open + late;
  const r = 86;
  const cx = 110;
  const cy = 104;
  const stroke = 20;
  const segments = [
    { key: "paid", label: "Paid", value: paid, color: STATUS.paid },
    { key: "open", label: "Open, not late", value: open, color: STATUS.open },
    { key: "late", label: "Late", value: late, color: STATUS.late },
  ];
  // A half circle from 180° to 360°, with a small gap between segments.
  const point = (t: number) => {
    const a = Math.PI * (1 + t);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
  };
  let start = 0;
  const gap = total > 0 ? 0.008 : 0;
  const arcs = segments.map((s) => {
    const share = total > 0 ? s.value / total : 0;
    const from = start + (start > 0 ? gap : 0);
    const to = start + share;
    start = to;
    if (share <= gap) return null;
    const [x1, y1] = point(from);
    const [x2, y2] = point(to);
    return <path key={s.key} d={`M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`} stroke={s.color} strokeWidth={stroke} fill="none" strokeLinecap="butt" />;
  });
  const pct = total > 0 ? Math.round((paid / total) * 100) : 0;
  return (
    <figure className="mgr-gauge" aria-label={`${pct}% of charges due collected: ${money(paid)} paid, ${money(open)} open, ${money(late)} late`}>
      <svg viewBox="0 0 220 120" role="img" aria-hidden="true">
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} stroke="#e6ebf1" strokeWidth={stroke} fill="none" />
        {arcs}
        <text x={cx} y={cy - 22} textAnchor="middle" className="mgr-gauge__value">{pct}%</text>
        <text x={cx} y={cy - 4} textAnchor="middle" className="mgr-gauge__label">collected</text>
      </svg>
      <figcaption>
        <ul className="mgr-gauge__keys">
          {segments.map((s) => (
            <li key={s.key}>
              <span className="mgr-legend__swatch" style={{ background: s.color }} aria-hidden="true" />
              <span>{s.label}</span>
              <strong>{money(s.value)}</strong>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ *
 * Monthly income vs expenses (bars) with net (line), one money axis
 * ------------------------------------------------------------------ */

export interface MonthPoint {
  label: string;
  income: number;
  expenses: number;
  net: number;
  billed?: number;
}

export function IncomeExpenseChart({ months, height = 280 }: { months: MonthPoint[]; height?: number }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { top: 16, right: 12, bottom: 30, left: 52 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const ticks = moneyTicks(Math.min(0, ...months.map((m) => m.net)), Math.max(1, ...months.map((m) => Math.max(m.income, m.expenses, m.net))));
  const top = ticks[ticks.length - 1]!;
  const bottom = ticks[0]!;
  const y = (v: number) => pad.top + ((top - v) / (top - bottom)) * innerH;
  const band = innerW / Math.max(1, months.length);
  const barW = Math.max(3, Math.min(18, (band - 10) / 2));
  const cxOf = (i: number) => pad.left + band * i + band / 2;
  const showEvery = band < 44 ? 2 : 1;
  const linePath = months.map((m, i) => `${i ? "L" : "M"} ${cxOf(i)} ${y(m.net)}`).join(" ");
  const h = hover === null ? null : months[hover];

  // Rounded top for a bar standing on the baseline (4px corners on the data end only).
  const bar = (x: number, v: number, color: string, key: string) => {
    const y0 = y(0);
    const y1 = y(Math.max(0, v));
    const hgt = Math.max(0, y0 - y1);
    if (hgt < 0.5) return null;
    const rr = Math.min(4, barW / 2, hgt);
    return (
      <path
        key={key}
        d={`M ${x} ${y0} V ${y1 + rr} Q ${x} ${y1} ${x + rr} ${y1} H ${x + barW - rr} Q ${x + barW} ${y1} ${x + barW} ${y1 + rr} V ${y0} Z`}
        fill={color}
      />
    );
  };

  return (
    <div className="mgr-chart" ref={ref}>
      <Legend
        items={[
          { label: "Collected", color: SERIES.income },
          { label: "Expenses", color: SERIES.expense },
          { label: "Net (collected − expenses)", color: SERIES.net, line: true },
        ]}
      />
      <svg width={width} height={height} role="img" aria-label="Monthly money collected, expenses and net" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className={t === 0 ? "mgr-axis-zero" : "mgr-grid-line"} />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className="mgr-axis-text">
              {short(t)}
            </text>
          </g>
        ))}
        {hover !== null && <rect x={pad.left + band * hover} y={pad.top} width={band} height={innerH} className="mgr-chart__hover" />}
        {months.map((m, i) => {
          const x = cxOf(i) - barW - 1;
          return (
            <g key={m.label}>
              {bar(x, m.income, SERIES.income, "i")}
              {bar(x + barW + 2, m.expenses, SERIES.expense, "e")}
              {i % showEvery === 0 && (
                <text x={cxOf(i)} y={height - 10} textAnchor="middle" className="mgr-axis-text">
                  {m.label.split(" ")[0]}
                </text>
              )}
            </g>
          );
        })}
        <path d={linePath} fill="none" stroke={SERIES.net} strokeWidth={2} strokeLinejoin="round" />
        {months.map((m, i) => (
          <circle key={i} cx={cxOf(i)} cy={y(m.net)} r={hover === i ? 5 : 3.5} fill={SERIES.net} stroke="#fff" strokeWidth={2} />
        ))}
        {months.map((m, i) => (
          <rect
            key={`hit-${i}`}
            x={pad.left + band * i}
            y={pad.top}
            width={band}
            height={innerH}
            fill="transparent"
            tabIndex={0}
            aria-label={`${m.label}: collected ${money(m.income)}, expenses ${money(m.expenses)}, net ${money(m.net)}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          />
        ))}
      </svg>
      {h && hover !== null && (
        <Tooltip x={cxOf(hover)} y={pad.top + 34} width={width}>
          <strong>{h.label}</strong>
          {h.billed !== undefined && (
            <span>
              Billed <b>{money(h.billed)}</b>
            </span>
          )}
          <span>
            <i style={{ background: SERIES.income }} /> Collected <b>{money(h.income)}</b>
          </span>
          <span>
            <i style={{ background: SERIES.expense }} /> Expenses <b>{money(h.expenses)}</b>
          </span>
          <span>
            <i style={{ background: SERIES.net }} /> Net <b>{money(h.net)}</b>
          </span>
        </Tooltip>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * A percent line over months (collection rate, occupancy), 0–100%
 * ------------------------------------------------------------------ */

export function PercentLines({ labels, series, height = 220 }: { labels: string[]; series: Array<{ name: string; color: string; values: number[] }>; height?: number }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { top: 14, right: 14, bottom: 28, left: 44 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (labels.length <= 1 ? innerW / 2 : (innerW * i) / (labels.length - 1));
  const y = (v: number) => pad.top + (1 - Math.max(0, Math.min(1, v))) * innerH;
  const step = innerW / Math.max(1, labels.length - 1);
  return (
    <div className="mgr-chart" ref={ref}>
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.name, color: s.color, line: true }))} />}
      <svg width={width} height={height} role="img" aria-label={series.map((s) => s.name).join(" and ") + " by month"} onMouseLeave={() => setHover(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className={t === 0 ? "mgr-axis-zero" : "mgr-grid-line"} />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end" className="mgr-axis-text">
              {Math.round(t * 100)}%
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % (step < 40 ? 2 : 1) === 0 ? (
            <text key={l} x={x(i)} y={height - 9} textAnchor="middle" className="mgr-axis-text">
              {l.split(" ")[0]}
            </text>
          ) : null,
        )}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} className="mgr-crosshair" />}
        {series.map((s) => (
          <g key={s.name}>
            <path d={s.values.map((v, i) => `${i ? "L" : "M"} ${x(i)} ${y(v)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
            {s.values.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 0} fill={s.color} stroke="#fff" strokeWidth={2} />
            ))}
          </g>
        ))}
        {labels.map((l, i) => (
          <rect
            key={`hit-${l}`}
            x={x(i) - step / 2}
            y={pad.top}
            width={step}
            height={innerH}
            fill="transparent"
            tabIndex={0}
            aria-label={`${l}: ${series.map((s) => `${s.name} ${Math.round((s.values[i] ?? 0) * 100)}%`).join(", ")}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
          />
        ))}
      </svg>
      {hover !== null && (
        <Tooltip x={x(hover)} y={pad.top + 20} width={width}>
          <strong>{labels[hover]}</strong>
          {series.map((s) => (
            <span key={s.name}>
              <i style={{ background: s.color }} /> {s.name} <b>{Math.round((s.values[hover] ?? 0) * 100)}%</b>
            </span>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Aging: what is owed, split by how late, as one stacked bar
 * ------------------------------------------------------------------ */

export function AgingBar({ aging }: { aging: { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number; total: number } }) {
  const parts = [
    { label: "Not late yet", value: aging.current, color: "#c9d3de" },
    { label: "1–30 days", value: aging.d1_30, color: AGING[0]! },
    { label: "31–60 days", value: aging.d31_60, color: AGING[1]! },
    { label: "61–90 days", value: aging.d61_90, color: AGING[2]! },
    { label: "90+ days", value: aging.d90plus, color: AGING[3]! },
  ];
  const total = Math.max(aging.total, 0.01);
  return (
    <div className="mgr-aging">
      <div className="mgr-aging__bar" role="img" aria-label={parts.map((p) => `${p.label} ${money(p.value)}`).join(", ")}>
        {parts.map((p) =>
          p.value > 0 ? <span key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.label}: ${money(p.value)}`} /> : null,
        )}
      </div>
      <dl className="mgr-aging__keys">
        {parts.map((p) => (
          <div key={p.label}>
            <dt>
              <span className="mgr-legend__swatch" style={{ background: p.color }} aria-hidden="true" />
              {p.label}
            </dt>
            <dd className={p.value > 0 && p.label !== "Not late yet" ? "mgr-owes" : undefined}>{money(p.value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Horizontal bars with the value written at the end (expense categories, properties). */
export function HBars({ rows, color, total }: { rows: Array<{ label: string; value: number; note?: string }>; color: string; total?: number }) {
  const max = Math.max(0.01, ...rows.map((r) => r.value));
  return (
    <ul className="mgr-hbars">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="mgr-hbars__label">{r.label}</span>
          <span className="mgr-hbars__track">
            <span style={{ width: `${(r.value / max) * 100}%`, background: color }} />
          </span>
          <span className="mgr-hbars__value">
            {money(r.value, false)}
            {total ? <span className="mgr-muted"> · {Math.round((r.value / total) * 100)}%</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
