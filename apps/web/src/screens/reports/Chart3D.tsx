/**
 * The report charts: pie, column, line or bubble, drawn with depth, chosen from a box on each
 * chart. Hovering (or tabbing to) a mark shows its exact figure; the numbers also stay in a
 * table under each chart. Depth is decoration only: sizes come from the values, never from
 * the perspective. The colours passed dataviz's validator as a set of five, in this order.
 */
import { useId, useState } from 'react';
import { SelectField } from '../../components/Field.tsx';

export type ChartKind = 'pie' | 'column' | 'line' | 'bubble';
export interface ChartRow {
  label: string;
  value: number;
}

const COLOURS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'];
const OTHER = '#9a958c';
const W = 640;
const H = 260;
const BASE = 220;
const LEFT = 16;
const DEPTH = 12;
const colour = (i: number) => COLOURS[i % COLOURS.length] ?? OTHER;
const money = (v: number) => `Rs ${v.toLocaleString('en-PK', { maximumFractionDigits: 0 })}`;

/** The same hue, lighter or darker, for the lit top and the shaded side. */
function shade(hex: string, by: number): string {
  const n = parseInt(hex.slice(1), 16);
  const part = (s: number) => {
    const c = (n >> s) & 255;
    const t = by < 0 ? c * (1 + by) : c + (255 - c) * by;
    return Math.round(t).toString(16).padStart(2, '0');
  };
  return `#${part(16)}${part(8)}${part(0)}`;
}

/** The biggest slices and "Other": more than seven slices cannot be told apart. */
function forPie(rows: ChartRow[]): { label: string; value: number; fill: string }[] {
  const busy = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  const top = busy.slice(0, 5).map((r, i) => ({ ...r, fill: colour(i) }));
  const rest = busy.slice(5).reduce((sum, r) => sum + r.value, 0);
  return rest > 0 ? [...top, { label: 'Other', value: rest, fill: OTHER }] : top;
}

export function Chart3D({
  title,
  rows,
  initial,
}: {
  title: string;
  rows: ChartRow[];
  initial: ChartKind;
}) {
  const [kind, setKind] = useState<ChartKind>(initial);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const gradient = useId();
  const max = Math.max(1, ...rows.map((r) => r.value));
  const busy = rows.filter((r) => r.value !== 0);
  const total = busy.reduce((sum, r) => sum + r.value, 0);
  const step = (W - LEFT * 2 - DEPTH) / Math.max(1, rows.length);
  const yOf = (v: number) => BASE - (v / max) * (BASE - 30);
  const xOf = (i: number) => LEFT + step * (i + 0.5);
  const hover = (x: number, y: number, label: string, value: number) => ({
    tabIndex: 0,
    onMouseEnter: () => {
      setTip({ x, y, text: `${label}: ${money(value)}` });
    },
    onFocus: () => {
      setTip({ x, y, text: `${label}: ${money(value)}` });
    },
    onMouseLeave: () => {
      setTip(null);
    },
    onBlur: () => {
      setTip(null);
    },
  });

  const axis = (
    <>
      <line x1={LEFT} x2={W - LEFT} y1={BASE} y2={BASE} className="chart-axis" />
      {rows.map((r, i) =>
        i % Math.ceil(rows.length / 8) === 0 ? (
          <text key={r.label} x={xOf(i)} y={BASE + 18} textAnchor="middle" className="chart-label">
            {r.label.length > 5 ? r.label.slice(5) : r.label}
          </text>
        ) : null,
      )}
    </>
  );

  const body = () => {
    if (kind === 'pie') {
      const slices = forPie(rows);
      const cx = W / 2 - 90;
      const cy = 105;
      const rx = 150;
      const ry = 82;
      let angle = -Math.PI / 2;
      const arcs = slices.map((s) => {
        const sweep = (s.value / Math.max(1, total)) * Math.PI * 2;
        const from = angle;
        angle += sweep;
        const to = angle;
        const at = (a: number, dy = 0) =>
          `${(cx + rx * Math.cos(a)).toFixed(1)} ${(cy + dy + ry * Math.sin(a)).toFixed(1)}`;
        const path = (dy: number) =>
          slices.length === 1
            ? `M ${String(cx - rx)} ${String(cy + dy)} a ${String(rx)} ${String(ry)} 0 1 0 ${String(rx * 2)} 0 a ${String(rx)} ${String(ry)} 0 1 0 ${String(-rx * 2)} 0 Z`
            : `M ${String(cx)} ${String(cy + dy)} L ${at(from, dy)} A ${String(rx)} ${String(ry)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${at(to, dy)} Z`;
        return { ...s, path, mid: from + sweep / 2 };
      });
      return (
        <>
          {Array.from({ length: 20 }, (_, i) => 20 - i).map((dy) =>
            arcs.map((a) => (
              <path key={`${a.label}${String(dy)}`} d={a.path(dy)} fill={shade(a.fill, -0.3)} />
            )),
          )}
          {arcs.map((a) => (
            <path
              key={a.label}
              d={a.path(0)}
              fill={a.fill}
              stroke="var(--surface-raised)"
              strokeWidth={2}
              {...hover(
                cx + (rx / 2) * Math.cos(a.mid),
                cy + (ry / 2) * Math.sin(a.mid),
                a.label,
                a.value,
              )}
            />
          ))}
          {arcs.map((a, i) => (
            <g key={`legend-${a.label}`}>
              <rect x={W - 210} y={30 + i * 26} width={14} height={14} rx={3} fill={a.fill} />
              <text x={W - 188} y={42 + i * 26} className="chart-legend">
                {a.label.slice(0, 16)} {((a.value / Math.max(1, total)) * 100).toFixed(0)}%
              </text>
            </g>
          ))}
        </>
      );
    }
    if (kind === 'column') {
      const w = Math.max(4, step * 0.6);
      const d = Math.min(DEPTH, w / 2);
      return (
        <>
          {axis}
          {rows.map((r, i) => {
            const x = xOf(i) - w / 2;
            const y = yOf(r.value);
            if (r.value === 0) return null;
            const fill = COLOURS[0] ?? OTHER;
            return (
              <g key={r.label} {...hover(xOf(i), y, r.label, r.value)}>
                <polygon
                  points={`${String(x + w)},${String(y)} ${String(x + w + d)},${String(y - d)} ${String(x + w + d)},${String(BASE - d)} ${String(x + w)},${String(BASE)}`}
                  fill={shade(fill, -0.3)}
                />
                <polygon
                  points={`${String(x)},${String(y)} ${String(x + d)},${String(y - d)} ${String(x + w + d)},${String(y - d)} ${String(x + w)},${String(y)}`}
                  fill={shade(fill, 0.35)}
                />
                <rect x={x} y={y} width={w} height={BASE - y} fill={fill} />
              </g>
            );
          })}
        </>
      );
    }
    if (kind === 'line') {
      const points = rows.map((r, i) => [xOf(i), yOf(r.value)] as const);
      const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
      const back = points.map(([x, y]) => `${(x + DEPTH).toFixed(1)},${(y - DEPTH).toFixed(1)}`);
      const fill = COLOURS[1] ?? OTHER;
      return (
        <>
          {axis}
          <polygon points={`${line} ${back.reverse().join(' ')}`} fill={shade(fill, 0.45)} />
          <polyline
            points={line}
            fill="none"
            stroke={fill}
            strokeWidth={3}
            strokeLinejoin="round"
          />
          {points.map(([x, y], i) => {
            const r = rows[i];
            return r ? (
              <circle
                key={r.label}
                cx={x}
                cy={y}
                r={5}
                fill={fill}
                stroke="var(--surface-raised)"
                strokeWidth={2}
                {...hover(x, y, r.label, r.value)}
              />
            ) : null;
          })}
        </>
      );
    }
    return (
      <>
        <defs>
          <radialGradient id={gradient} cx="35%" cy="30%">
            <stop offset="0%" stopColor={shade(COLOURS[2] ?? OTHER, 0.6)} />
            <stop offset="100%" stopColor={shade(COLOURS[2] ?? OTHER, -0.25)} />
          </radialGradient>
        </defs>
        {axis}
        {rows.map((r, i) =>
          r.value === 0 ? null : (
            <circle
              key={r.label}
              cx={xOf(i)}
              cy={yOf(r.value)}
              // The area, not the radius, follows the value.
              r={Math.max(4, Math.sqrt(r.value / max) * Math.min(26, step * 0.9))}
              fill={`url(#${gradient})`}
              {...hover(xOf(i), yOf(r.value), r.label, r.value)}
            />
          ),
        )}
      </>
    );
  };

  return (
    <>
      <SelectField
        label={`Chart type: ${title}`}
        value={kind}
        options={[
          { value: 'pie', label: '3D pie' },
          { value: 'column', label: '3D column' },
          { value: 'line', label: '3D line' },
          { value: 'bubble', label: '3D bubble' },
        ]}
        onChange={(v) => {
          setTip(null);
          setKind(v as ChartKind);
        }}
      />
      <div className="chart-frame">
        <svg
          role="img"
          aria-label={`${title}: ${busy.length === 0 ? 'nothing yet' : busy.map((r) => `${r.label} Rs ${r.value.toFixed(0)}`).join(', ')}`}
          viewBox={`0 0 ${String(W)} ${String(H)}`}
          className="chart-svg"
        >
          {busy.length === 0 ? (
            <text x={W / 2} y={H / 2} textAnchor="middle" className="chart-legend">
              Nothing yet in this period
            </text>
          ) : (
            body()
          )}
        </svg>
        {tip ? (
          <div
            className="chart-tip"
            role="status"
            style={{
              left: `${String(Math.min(85, Math.max(15, (tip.x / W) * 100)))}%`,
              top: `${String((tip.y / H) * 100)}%`,
            }}
          >
            {tip.text}
          </div>
        ) : null}
      </div>
    </>
  );
}
