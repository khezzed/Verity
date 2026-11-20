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
  const width = 820;
  const height = 270;
  const pad = { top: 26, right: 32, bottom: 38, left: 64 };
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
    Math.abs(boundA) * 1.28,
    Math.abs(boundB) * 1.28,
    ...points.map((p) => Math.abs(p.llr) * 1.18)
  );
  const yMin = -yAbsMax;
  const yMax = yAbsMax;

  const xOf = (step: number) => pad.left + (step / maxStep) * plotW;
  const yOf = (val: number) => pad.top + ((yMax - val) / (yMax - yMin)) * plotH;

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xOf(p.step).toFixed(1)} ${yOf(p.llr).toFixed(1)}`)
    .join(' ');

  const yA = yOf(boundA);
  const yB = yOf(boundB);
  const y0 = yOf(0);

  const sampledCount = audit.samples.length;
  const savedCount = Math.max(0, totalEntries - sampledCount);
  const savedPct = totalEntries > 0 ? Math.round((savedCount / totalEntries) * 100) : 0;

  const strokeColor =
    audit.status === 'SETTLED_CERTIFIED'
      ? '#0D7A52'
      : audit.status === 'SETTLED_REJECTED'
      ? '#C4243B'
      : '#1D4ED8';

  return (
    <div className="sheet-band">
      <div className="band-header">
        <div>
          <h2 className="section-heading">Sequential probability ratio trajectory</h2>
          <p className="section-desc">
            Fixed-point Wald SPRT log-likelihood walk across Fisher-Yates draws. Select any plotted node to inspect its verified source passage below.
          </p>
        </div>

        <div className="stat-readout-row">
          <div className="stat-readout">
            <span className="stat-readout-label">Sampled</span>
            <span className="stat-readout-val">
              {sampledCount} of {totalEntries}
            </span>
          </div>
          <div className="stat-readout">
            <span className="stat-readout-label">Work saved</span>
            <span className="stat-readout-val outcome-text certify">{savedPct}%</span>
          </div>
          <div className="stat-readout">
            <span className="stat-readout-label">Final LLR</span>
            <span
              className={`stat-readout-val outcome-text ${
                audit.llr_scaled <= audit.bound_certify
                  ? 'certify'
                  : audit.llr_scaled >= audit.bound_reject
                  ? 'reject'
                  : 'pending'
              }`}
            >
              {formatLlr(audit.llr_scaled)}
            </span>
          </div>
        </div>
      </div>

      <div className="sprt-canvas-wrap">
        <svg
          key={`audit-${audit.audit_id}-${audit.samples.length}`}
          viewBox={`0 0 ${width} ${height}`}
          className="sprt-svg"
          role="img"
          aria-label="Wald SPRT log-likelihood ratio trajectory"
        >
          {/* Upper reject corridor */}
          <rect
            x={pad.left}
            y={pad.top}
            width={plotW}
            height={Math.max(0, yA - pad.top)}
            fill="#FDECEF"
          />
          {/* Lower certify corridor */}
          <rect
            x={pad.left}
            y={yB}
            width={plotW}
            height={Math.max(0, pad.top + plotH - yB)}
            fill="#E8F7F0"
          />

          {/* Corridor labels */}
          <text x={pad.left + 10} y={pad.top + 17} fill="#991B2E" className="svg-zone-text">
            Reject threshold (LLR ≥ +{boundA.toFixed(2)})
          </text>
          <text x={pad.left + 10} y={pad.top + plotH - 9} fill="#0A5C3D" className="svg-zone-text">
            Certify threshold (LLR ≤ {boundB.toFixed(2)})
          </text>

          {/* Vertical draw gridlines */}
          {Array.from({ length: maxStep + 1 }, (_, s) => {
            const x = xOf(s);
            return (
              <g key={s}>
                <line x1={x} y1={pad.top} x2={x} y2={pad.top + plotH} stroke="rgba(15, 28, 46, 0.07)" />
                <text x={x} y={pad.top + plotH + 20} textAnchor="middle" className="svg-axis-text">
                  {s === 0 ? 'Start' : `Draw ${s}`}
                </text>
              </g>
            );
          })}

          {/* Stopping boundary lines & zero baseline */}
          <line x1={pad.left} y1={yA} x2={pad.left + plotW} y2={yA} stroke="#C4243B" strokeWidth="1.4" strokeDasharray="5 4" />
          <line x1={pad.left} y1={y0} x2={pad.left + plotW} y2={y0} stroke="rgba(15, 28, 46, 0.28)" strokeWidth="1" />
          <line x1={pad.left} y1={yB} x2={pad.left + plotW} y2={yB} stroke="#0D7A52" strokeWidth="1.4" strokeDasharray="5 4" />

          {/* Y axis ticks */}
          <text x={pad.left - 10} y={yA + 4} textAnchor="end" fill="#C4243B" className="svg-axis-text">
            +{boundA.toFixed(2)}
          </text>
          <text x={pad.left - 10} y={y0 + 4} textAnchor="end" className="svg-axis-text">
            0.00
          </text>
          <text x={pad.left - 10} y={yB + 4} textAnchor="end" fill="#0D7A52" className="svg-axis-text">
            {boundB.toFixed(2)}
          </text>

          {/* Outer hairline frame */}
          <rect
            x={pad.left}
            y={pad.top}
            width={plotW}
            height={plotH}
            fill="none"
            stroke="rgba(15, 28, 46, 0.16)"
          />

          {/* Trajectory line */}
          {points.length > 1 && (
            <path
              d={pathD}
              fill="none"
              stroke={strokeColor}
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              className="sprt-path"
            />
          )}

          {/* Waypoints */}
          {points.map((p) => {
            const cx = xOf(p.step);
            const cy = yOf(p.llr);
            const isSelected = p.entryIdx >= 0 && selectedEntryIdx === p.entryIdx;
            const fill =
              p.verdict === 'START'
                ? '#42526B'
                : p.verdict === 'SUPPORTED'
                ? '#0D7A52'
                : p.verdict === 'UNSUPPORTED'
                ? '#C4243B'
                : '#9A5200';
            return (
              <g
                key={p.step}
                className={p.entryIdx >= 0 ? 'svg-node-interactive' : undefined}
                onClick={() => p.entryIdx >= 0 && onSelectEntry(p.entryIdx)}
                role={p.entryIdx >= 0 ? 'button' : undefined}
                tabIndex={p.entryIdx >= 0 ? 0 : undefined}
                onKeyDown={(e) => {
                  if (p.entryIdx >= 0 && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    onSelectEntry(p.entryIdx);
                  }
                }}
              >
                {isSelected && (
                  <circle cx={cx} cy={cy} r={11} fill="rgba(29, 78, 216, 0.14)" stroke="#1D4ED8" strokeWidth="1.5" />
                )}
                <circle
                  className="node-core"
                  cx={cx}
                  cy={cy}
                  r={p.step === 0 ? 4 : isSelected ? 6.5 : 5.5}
                  fill={fill}
                  stroke="#FFFFFF"
                  strokeWidth="2"
                />
                {p.step > 0 && (() => {
                  // Always place point labels on the clear side away from the ±2.20 dashed bounds
                  let dy = -14;
                  if (p.llr > 0 && p.llr < boundA) {
                    dy = 21; // inside upper continue zone: place below node, clear of +boundA line
                  } else if (p.llr >= boundA) {
                    dy = -14; // crossed above +boundA: place above node
                  } else if (p.llr < 0 && p.llr > boundB) {
                    dy = -14; // inside lower continue zone: place above node, clear of -boundB line
                  } else {
                    dy = 21; // crossed below -boundB: place below node
                  }
                  // Clamp inside SVG vertical bounds
                  const labelY = Math.max(pad.top + 16, Math.min(pad.top + plotH - 6, cy + dy));
                  return (
                    <text
                      x={cx}
                      y={labelY}
                      textAnchor="middle"
                      className="svg-node-label"
                    >
                      E{p.entryIdx} ({p.llr >= 0 ? '+' : ''}
                      {p.llr.toFixed(2)})
                    </text>
                  );
                })()}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="sprt-footnote">
        <span>
          Profile: <strong>{audit.profile_id}</strong>
        </span>
        <span>
          Commit-reveal seed:{' '}
          <strong className="code-hex">{audit.seed_hex ? `${audit.seed_hex.slice(0, 14)}...` : 'Unrevealed'}</strong>
        </span>
        <span>
          Permutation order: <strong className="code-hex">[{audit.sample_order.join(', ')}]</strong>
        </span>
        <span>
          Terminal outcome: <strong>{audit.terminal_decision || audit.status}</strong>
        </span>
      </div>
    </div>
  );
};
