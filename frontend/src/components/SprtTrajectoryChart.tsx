import React from 'react';
import type { AuditRecord } from '../types/verity';
import { formatLlr } from '../lib/studionetClient';

interface Props {
  audit: AuditRecord;
  totalEntries: number;
  selectedEntryIdx: number | null;
  onSelectEntry: (entryIdx: number) => void;
}

export const SprtTrajectoryChart: React.FC<Props> = ({
  audit,
  totalEntries,
  selectedEntryIdx,
  onSelectEntry,
}) => {
  const width = 760;
  const height = 276;
  const pad = { top: 28, right: 34, bottom: 42, left: 68 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const boundA = audit.bound_reject / 1_000_000;
  const boundB = audit.bound_certify / 1_000_000;

  const points = [
    { step: 0, llr: 0, entryIdx: -1, verdict: 'START', delta: 0 },
    ...audit.samples.map((s) => ({
      step: s.seq,
      llr: s.llr_after / 1_000_000,
      entryIdx: s.entry_idx,
      verdict: s.verdict,
      delta: s.llr_delta / 1_000_000,
    })),
  ];

  const maxStep = Math.max(4, points.length - 1, Math.min(totalEntries, points.length + 1));
  const yAbsMax = Math.max(
    Math.abs(boundA) * 1.25,
    Math.abs(boundB) * 1.25,
    ...points.map((p) => Math.abs(p.llr) * 1.15)
  );
  const yMin = -yAbsMax;
  const yMax = yAbsMax;

  const xOf = (step: number) => pad.left + (step / maxStep) * plotW;
  const yOf = (val: number) => pad.top + ((yMax - val) / (yMax - yMin)) * plotH;

  const polylinePoints = points.map((p) => `${xOf(p.step).toFixed(1)},${yOf(p.llr).toFixed(1)}`).join(' ');
  const yA = yOf(boundA);
  const yB = yOf(boundB);
  const y0 = yOf(0);

  const sampledCount = audit.samples.length;
  const savedCount = Math.max(0, totalEntries - sampledCount);
  const savedPct = totalEntries > 0 ? Math.round((savedCount / totalEntries) * 100) : 0;

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h3 className="panel-title">Wald SPRT Log-Likelihood Trajectory (Λₜ)</h3>
          <p className="panel-subtitle">
            Exact scaled-integer sequential hypothesis test (scale = 10⁶). Click any sample node to inspect its verbatim evidence quote.
          </p>
        </div>
        <div className="kpi-inline-group">
          <div className="mini-stat">
            <span className="mini-label">Samples Audited</span>
            <span className="mini-value mono">
              {sampledCount} / {totalEntries}
            </span>
          </div>
          <div className="mini-stat">
            <span className="mini-label">Validator Work Saved</span>
            <span className="mini-value mono accent-emerald">{savedPct}%</span>
          </div>
          <div className="mini-stat">
            <span className="mini-label">Current LLR</span>
            <span
              className={`mini-value mono ${
                audit.llr_scaled <= audit.bound_certify
                  ? 'accent-emerald'
                  : audit.llr_scaled >= audit.bound_reject
                  ? 'accent-crimson'
                  : 'accent-amber'
              }`}
            >
              {formatLlr(audit.llr_scaled)}
            </span>
          </div>
        </div>
      </div>

      <div className="chart-wrap">
        <svg viewBox={`0 0 ${width} ${height}`} className="sprt-svg" role="img" aria-label="Wald SPRT trajectory chart">
          {/* Reject Zone (top) */}
          <rect
            x={pad.left}
            y={pad.top}
            width={plotW}
            height={Math.max(0, yA - pad.top)}
            fill="rgba(244, 63, 94, 0.10)"
          />
          {/* Continue Zone (middle) */}
          <rect
            x={pad.left}
            y={yA}
            width={plotW}
            height={Math.max(0, yB - yA)}
            fill="rgba(245, 158, 11, 0.04)"
          />
          {/* Certify Zone (bottom) */}
          <rect
            x={pad.left}
            y={yB}
            width={plotW}
            height={Math.max(0, pad.top + plotH - yB)}
            fill="rgba(16, 185, 129, 0.10)"
          />

          {/* Zone labels */}
          <text x={pad.left + 8} y={pad.top + 14} className="svg-zone-label reject">
            REJECT / SLASH ZONE (Λ ≥ +{boundA.toFixed(2)})
          </text>
          <text x={pad.left + 8} y={pad.top + plotH - 8} className="svg-zone-label certify">
            CERTIFY SOUND ZONE (Λ ≤ {boundB.toFixed(2)})
          </text>

          {/* Horizontal threshold & zero lines */}
          <line x1={pad.left} y1={yA} x2={pad.left + plotW} y2={yA} stroke="#F43F5E" strokeWidth="1.5" strokeDasharray="6 4" />
          <line x1={pad.left} y1={y0} x2={pad.left + plotW} y2={y0} stroke="#475569" strokeWidth="1" strokeDasharray="3 3" />
          <line x1={pad.left} y1={yB} x2={pad.left + plotW} y2={yB} stroke="#10B981" strokeWidth="1.5" strokeDasharray="6 4" />

          {/* Y axis labels */}
          <text x={pad.left - 10} y={yA + 4} textAnchor="end" className="svg-axis-label reject">
            +{boundA.toFixed(2)}
          </text>
          <text x={pad.left - 10} y={y0 + 4} textAnchor="end" className="svg-axis-label">
            0.00
          </text>
          <text x={pad.left - 10} y={yB + 4} textAnchor="end" className="svg-axis-label certify">
            {boundB.toFixed(2)}
          </text>

          {/* X axis grid + ticks */}
          {Array.from({ length: maxStep + 1 }, (_, s) => {
            const x = xOf(s);
            return (
              <g key={s}>
                <line x1={x} y1={pad.top} x2={x} y2={pad.top + plotH} stroke="rgba(148,163,184,0.09)" />
                <text x={x} y={pad.top + plotH + 18} textAnchor="middle" className="svg-axis-label">
                  {s === 0 ? 't=0' : `t=${s}`}
                </text>
              </g>
            );
          })}

          {/* Axes frame */}
          <rect
            x={pad.left}
            y={pad.top}
            width={plotW}
            height={plotH}
            fill="none"
            stroke="rgba(148,163,184,0.22)"
          />

          {/* Random walk polyline */}
          {points.length > 1 && (
            <polyline
              fill="none"
              stroke={
                audit.status === 'SETTLED_CERTIFIED'
                  ? '#10B981'
                  : audit.status === 'SETTLED_REJECTED'
                  ? '#F43F5E'
                  : '#F59E0B'
              }
              strokeWidth="2.6"
              strokeLinejoin="round"
              strokeLinecap="round"
              points={polylinePoints}
            />
          )}

          {/* Waypoint dots */}
          {points.map((p) => {
            const cx = xOf(p.step);
            const cy = yOf(p.llr);
            const isSelected = p.entryIdx >= 0 && selectedEntryIdx === p.entryIdx;
            const fill =
              p.verdict === 'START'
                ? '#94A3B8'
                : p.verdict === 'SUPPORTED'
                ? '#10B981'
                : p.verdict === 'UNSUPPORTED'
                ? '#F43F5E'
                : '#F59E0B';
            return (
              <g
                key={p.step}
                className={p.entryIdx >= 0 ? 'svg-node-clickable' : undefined}
                onClick={() => p.entryIdx >= 0 && onSelectEntry(p.entryIdx)}
              >
                {isSelected && <circle cx={cx} cy={cy} r={11} fill="none" stroke="#F8FAFC" strokeWidth="1.6" />}
                <circle cx={cx} cy={cy} r={p.step === 0 ? 4.5 : 6} fill={fill} stroke="#090C10" strokeWidth="2" />
                {p.step > 0 && (
                  <text
                    x={cx}
                    y={cy + (p.llr >= 0 ? -12 : 17)}
                    textAnchor="middle"
                    className="svg-node-tag"
                  >
                    #{p.entryIdx} ({p.llr >= 0 ? '+' : ''}
                    {p.llr.toFixed(2)})
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="chart-footer mono">
        <span>Profile: <strong>{audit.profile_id}</strong></span>
        <span>Seed: <strong>{audit.seed_hex ? `${audit.seed_hex.slice(0, 14)}…` : 'Unrevealed'}</strong></span>
        <span>Fisher-Yates Order: <strong>[{audit.sample_order.join(', ')}]</strong></span>
        <span>Decision: <strong>{audit.terminal_decision || audit.status}</strong></span>
      </div>
    </div>
  );
};
