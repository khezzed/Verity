import React from 'react';
import { ExternalLink, CornerDownRight } from 'lucide-react';
import type { RecordedTx } from '../types/verity';
import { shortHex } from '../lib/studionetClient';

interface Props {
  transactions: RecordedTx[];
  filterCaseId: string;
  onChangeFilter: (caseId: string) => void;
}

const FILTER_OPTIONS = [
  { id: 'all', label: 'All cases' },
  { id: 'case0_payable_guard', label: 'Payable guard' },
  { id: 'case1_rulegate_reject', label: 'RuleGate' },
  { id: 'case2_certified_sound', label: 'Certified sound' },
  { id: 'case3_rejected_defective', label: 'Rejected + injection' },
  { id: 'case4_deterministic_fallbacks', label: 'Fallbacks' },
];

export const FinalizedLedgerTable: React.FC<Props> = ({
  transactions,
  filterCaseId,
  onChangeFilter,
}) => {
  const rows =
    filterCaseId === 'all'
      ? transactions
      : transactions.filter((t) => t.caseId === filterCaseId || t.caseId === 'setup');

  const childCount = rows.reduce((acc, t) => acc + (t.emittedChildren?.length || 0), 0);

  return (
    <div className="instrument-sheet">
      <div className="table-toolbar">
        <div>
          <h2 className="section-heading">Finalized StudioNet transaction ledger</h2>
          <p className="section-desc">
            Showing {rows.length} parent writes and {childCount} emitted finality callbacks verified on Chain 61999.
          </p>
        </div>

        <div className="segmented light" role="tablist" aria-label="Filter proof transactions by case">
          {FILTER_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              role="tab"
              aria-selected={filterCaseId === opt.id}
              className={filterCaseId === opt.id ? 'active' : ''}
              onClick={() => onChangeFilter(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Step</th>
              <th>Method</th>
              <th>Status</th>
              <th>Return</th>
              <th>Explorer</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((tx) => (
              <React.Fragment key={tx.txHash}>
                <tr>
                  <td>
                    <div className="code-hex">{tx.step}</div>
                    <div className="kv-label">{tx.actor}</div>
                  </td>
                  <td className="code-hex">
                    {tx.contract.replace('Verity', '')}.{tx.method}()
                  </td>
                  <td>
                    <span className={`table-status ${tx.executionResult === 'SUCCESS' ? 'ok' : 'err'}`}>
                      {tx.executionResult === 'SUCCESS' ? 'Finalized' : 'Expected error'}
                    </span>
                  </td>
                  <td className="return-ellipsis code-hex" title={String(tx.returnReadable ?? '')}>
                    {String(tx.returnReadable ?? '') || 'OK'}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <a href={tx.explorerUrl} target="_blank" rel="noreferrer" className="code-hex">
                      {shortHex(tx.txHash, 5, 4)} <ExternalLink size={12} />
                    </a>
                  </td>
                </tr>
                {(tx.emittedChildren || []).map((child, idx) => (
                  <tr key={child.txHash} className="child-row">
                    <td>
                      <span className="child-label">
                        <CornerDownRight size={13} />
                        {idx === 0 ? 'Judge consensus' : 'Vault finality callback'}
                      </span>
                    </td>
                    <td className="code-hex">
                      {idx === 0 ? 'CitationJudge' : 'AuditVault (on="finalized")'}
                    </td>
                    <td>
                      <span className={`table-status ${child.executionResult === 'SUCCESS' ? 'ok' : 'err'}`}>
                        {child.executionResult === 'SUCCESS' ? 'Finalized' : 'Error'}
                      </span>
                    </td>
                    <td className="return-ellipsis code-hex" title={String(child.returnReadable ?? '')}>
                      {String(child.returnReadable ?? '') || 'OK'}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <a href={child.explorerUrl} target="_blank" rel="noreferrer" className="code-hex">
                        {shortHex(child.txHash, 5, 4)} <ExternalLink size={12} />
                      </a>
                    </td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
