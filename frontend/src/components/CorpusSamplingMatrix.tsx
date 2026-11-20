import React from 'react';
import { ExternalLink } from 'lucide-react';
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
  const orderedIndices =
    audit && audit.sample_order.length === corpus.entry_count
      ? audit.sample_order
      : corpus.entries.map((_, i) => i);

  const activeIdx =
    selectedEntryIdx !== null
      ? selectedEntryIdx
      : audit && audit.samples.length > 0
      ? audit.samples[0].entry_idx
      : 0;

  const activeEntry = corpus.entries[activeIdx];
  const activeSample = sampleByEntry.get(activeIdx);
  const isInjectionSource = Boolean(activeEntry?.source_url.includes('Open-Prompt-Injection'));

  return (
    <div className="evidence-split">
      {/* Left: Compact Citation Draw Index */}
      <div className="citation-index-col">
        <div className="col-subhead">
          <h2 className="section-heading">Citation index ({corpus.entry_count})</h2>
          <span className="kv-label tabular">
            {audit && audit.sample_order.length > 0 ? 'Ordered by Fisher-Yates draw' : 'Manifest order'}
          </span>
        </div>

        <ul className="citation-list" role="listbox" aria-label="Corpus citations">
          {orderedIndices.map((entryIdx, pos) => {
            const entry = corpus.entries[entryIdx];
            const sample = sampleByEntry.get(entryIdx);
            const isInj = entry.source_url.includes('Open-Prompt-Injection');

            let stateClass = 'pending';
            let stateText = 'Not sampled';
            if (sample) {
              if (sample.verdict === 'SUPPORTED') {
                stateClass = 'supported';
                stateText = 'Supported';
              } else if (sample.verdict === 'UNSUPPORTED') {
                stateClass = 'unsupported';
                stateText = isInj ? 'Injection blocked' : 'Unsupported';
              } else {
                stateClass = 'pending';
                stateText = 'Insufficient';
              }
            } else if (isSettled) {
              stateClass = 'skipped';
              stateText = 'Skipped early';
            }

            return (
              <li key={entryIdx}>
                <button
                  type="button"
                  role="option"
                  aria-selected={activeIdx === entryIdx}
                  className={`citation-row-btn ${activeIdx === entryIdx ? 'selected' : ''}`}
                  onClick={() => onSelectEntry(entryIdx)}
                >
                  <span className="citation-rank">
                    {audit && audit.sample_order.length > 0 ? `#${pos + 1}` : `E${entryIdx}`}
                  </span>
                  <span className="citation-claim-short">{entry.claim}</span>
                  <span className={`citation-state ${stateClass}`}>{stateText}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Right: Verbatim Evidence & Proof Monograph */}
      <div className="monograph-col">
        <div>
          <h2 className="section-heading">Entry {activeIdx} evidence record</h2>
          <p className="monograph-claim" style={{ marginTop: 8 }}>
            {activeEntry?.claim}
          </p>
        </div>

        {activeEntry && (
          <dl className="evidence-kv-list" style={{ margin: 0 }}>
            <div className="evidence-kv full">
              <dt className="kv-label">Immutable third-party source</dt>
              <dd className="kv-value" style={{ margin: 0 }}>
                <a href={activeEntry.source_url} target="_blank" rel="noreferrer" className="source-anchor-link code-hex">
                  {activeEntry.source_url} <ExternalLink size={13} />
                </a>
              </dd>
            </div>
            <div className="evidence-kv">
              <dt className="kv-label">Deterministic slice anchor</dt>
              <dd className="kv-value code-hex" style={{ margin: 0 }}>
                {activeEntry.anchor || 'Leading 2,200 chars'}
              </dd>
            </div>
            <div className="evidence-kv">
              <dt className="kv-label">Manifest SHA-256</dt>
              <dd className="kv-value code-hex" style={{ margin: 0 }} title={corpus.manifest_sha256}>
                {shortHex(`0x${corpus.manifest_sha256}`, 8, 6)}
              </dd>
            </div>
            {activeSample && (
              <>
                <div className="evidence-kv">
                  <dt className="kv-label">Validator slice SHA-256</dt>
                  <dd className="kv-value code-hex" style={{ margin: 0 }} title={activeSample.slice_sha256}>
                    {activeSample.slice_sha256 ? shortHex(`0x${activeSample.slice_sha256}`, 8, 6) : 'None'}
                  </dd>
                </div>
                <div className="evidence-kv">
                  <dt className="kv-label">Finalized step delta</dt>
                  <dd className="kv-value" style={{ margin: 0 }}>
                    {activeSample.verdict} ({formatLlr(activeSample.llr_delta)} LLR, fetch {activeSample.fetch_status})
                  </dd>
                </div>
              </>
            )}
          </dl>
        )}

        {activeSample ? (
          activeSample.verbatim_quote ? (
            <blockquote className="quote-monograph">
              <p>“{activeSample.verbatim_quote}”</p>
              <footer>Verified verbatim inside each validator&apos;s independently fetched slice.</footer>
            </blockquote>
          ) : (
            <div className="verdict-note-box reject">
              {isInjectionSource
                ? 'Prompt-injection defense verified live: validators treated the source excerpt strictly as untrusted data, ignored embedded "Ignore previous instructions" directives, and finalized UNSUPPORTED.'
                : 'Claim contradicted or unsubstantiated by the immutable source excerpt. Validators finalized UNSUPPORTED with an empty quote and incremented the SPRT log-likelihood ratio toward rejection.'}
            </div>
          )
        ) : (
          <div className="verdict-note-box neutral">
            {isSettled
              ? 'This entry was skipped via Wald SPRT early stopping because statistical certainty crossed the terminal bound before this draw slot was required.'
              : corpus.status === 'REJECTED_VAGUE'
              ? 'This corpus was rejected up front by the RuleGate before sampling began; 100% of the publisher bond was returned to refundable balances.'
              : 'This entry has not yet been sampled in an active audit.'}
          </div>
        )}
      </div>
    </div>
  );
};
