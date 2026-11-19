import React from 'react';
import { ExternalLink, ShieldAlert, CheckCircle2, XCircle, FastForward, HelpCircle } from 'lucide-react';
import type { AuditRecord, CorpusRecord, SampleRecord } from '../types/verity';
import { formatLlr, shortHex } from '../lib/studionetClient';

interface Props {
  corpus: CorpusRecord;
  audit: AuditRecord | null;
  selectedEntryIdx: number | null;
  onSelectEntry: (idx: number) => void;
}

export const CorpusSamplingMatrix: React.FC<Props> = ({
  corpus,
  audit,
  selectedEntryIdx,
  onSelectEntry,
}) => {
  const sampleByEntry = new Map<number, SampleRecord>();
  if (audit) {
    for (const s of audit.samples) {
      sampleByEntry.set(s.entry_idx, s);
    }
  }

  const isSettled = Boolean(audit?.status?.startsWith('SETTLED_'));
  const activeIdx =
    selectedEntryIdx !== null
      ? selectedEntryIdx
      : audit && audit.samples.length > 0
      ? audit.samples[0].entry_idx
      : 0;
  const activeEntry = corpus.entries[activeIdx];
  const activeSample = sampleByEntry.get(activeIdx);

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h3 className="panel-title">Corpus Sampling Matrix ({corpus.entry_count} Frozen Citations)</h3>
          <p className="panel-subtitle">
            Unbiased Fisher-Yates draws stop early once Wald SPRT crosses a statistical bound — skipping remaining entries without checking 100% on-chain.
          </p>
        </div>
        <span className="hash-pill mono" title={corpus.manifest_sha256}>
          manifest_sha256: {shortHex(`0x${corpus.manifest_sha256}`, 8, 6)}
        </span>
      </div>

      <div className="matrix-grid">
        {corpus.entries.map((entry, idx) => {
          const sample = sampleByEntry.get(idx);
          const isInjectionSrc = entry.source_url.includes('Open-Prompt-Injection');
          const orderPos = audit?.sample_order ? audit.sample_order.indexOf(idx) : -1;
          let stateClass = 'entry-pending';
          let badgeText = 'UNINSPECTED';
          let Icon = HelpCircle;

          if (sample) {
            if (sample.verdict === 'SUPPORTED') {
              stateClass = 'entry-supported';
              badgeText = `T=${sample.seq} • SUPPORTED`;
              Icon = CheckCircle2;
            } else if (sample.verdict === 'UNSUPPORTED') {
              stateClass = 'entry-unsupported';
              badgeText = isInjectionSrc ? `T=${sample.seq} • INJECTION DEFENDED` : `T=${sample.seq} • UNSUPPORTED`;
              Icon = isInjectionSrc ? ShieldAlert : XCircle;
            } else {
              stateClass = 'entry-insufficient';
              badgeText = `T=${sample.seq} • INSUFFICIENT`;
              Icon = HelpCircle;
            }
          } else if (isSettled) {
            stateClass = 'entry-skipped';
            badgeText = 'SKIPPED (EARLY STOP)';
            Icon = FastForward;
          }

          return (
            <button
              key={idx}
              type="button"
              className={`matrix-card ${stateClass} ${activeIdx === idx ? 'selected' : ''}`}
              onClick={() => onSelectEntry(idx)}
            >
              <div className="matrix-card-top">
                <span className="mono entry-index">ENTRY #{idx}</span>
                {orderPos >= 0 && <span className="mono draw-rank">draw #{orderPos + 1}</span>}
              </div>
              <div className="matrix-badge">
                <Icon size={14} />
                <span>{badgeText}</span>
              </div>
              <p className="matrix-claim-preview">{entry.claim}</p>
            </button>
          );
        })}
      </div>

      {activeEntry && (
        <div className="evidence-drawer">
          <div className="drawer-row">
            <span className="drawer-label">Claim #{activeIdx}</span>
            <p className="drawer-claim">{activeEntry.claim}</p>
          </div>

          <div className="drawer-meta-grid">
            <div>
              <span className="drawer-label">Immutable Third-Party Source</span>
              <a href={activeEntry.source_url} target="_blank" rel="noreferrer" className="source-link mono">
                {activeEntry.source_url} <ExternalLink size={13} />
              </a>
            </div>
            <div>
              <span className="drawer-label">Deterministic Slice Anchor</span>
              <span className="mono value-chip">{activeEntry.anchor || '(head 2200 chars)'}</span>
            </div>
          </div>

          {activeSample ? (
            <div className="verdict-evidence-box">
              <div className="verdict-evidence-head">
                <span className={`status-pill ${activeSample.verdict.toLowerCase()}`}>
                  {activeSample.verdict}
                </span>
                <span className="mono">fetch: {activeSample.fetch_status}</span>
                <span className="mono">LLR Δ: {formatLlr(activeSample.llr_delta)}</span>
                <span className="mono">
                  slice_sha256: {activeSample.slice_sha256 ? `${activeSample.slice_sha256.slice(0, 18)}…` : '—'}
                </span>
              </div>
              {activeSample.verbatim_quote ? (
                <blockquote className="verbatim-quote mono">
                  “{activeSample.verbatim_quote}”
                  <footer>Verified verbatim inside each GenLayer validator’s independently fetched slice.</footer>
                </blockquote>
              ) : (
                <div className="no-quote-note">
                  {activeEntry.source_url.includes('Open-Prompt-Injection')
                    ? 'Prompt-injection defense confirmed: validators ignored embedded "Ignore previous instructions" directives and returned UNSUPPORTED with empty quote.'
                    : 'No supporting verbatim quote — claim contradicted or unsubstantiated by the immutable source excerpt.'}
                </div>
              )}
            </div>
          ) : (
            <div className="no-quote-note">
              {isSettled
                ? 'Skipped via Wald SPRT early stopping — statistical certainty was reached before this draw slot was needed.'
                : 'Not yet sampled in an active audit.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
