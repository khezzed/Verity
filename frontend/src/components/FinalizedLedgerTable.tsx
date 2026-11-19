import React from 'react';
import { ExternalLink, CornerDownRight } from 'lucide-react';
import type { RecordedTx } from '../types/verity';
import { shortHex } from '../lib/studionetClient';

interface Props {
  transactions: RecordedTx[];
  filterCaseId: string;
}

export const FinalizedLedgerTable: React.FC<Props> = ({ transactions, filterCaseId }) => {
  const rows =
    filterCaseId === 'all'
      ? transactions
      : transactions.filter((t) => t.caseId === filterCaseId || t.caseId === 'setup');

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h3 className="panel-title">Finalized StudioNet Transaction Proof Ledger</h3>
          <p className="panel-subtitle">
            Every parent write and emitted <code>emit(on=&quot;finalized&quot;)</code> callback recorded from GenLayer StudioNet (Chain 61999).
          </p>
        </div>
        <span className="mono count-pill">{rows.length} parent txs</span>
      </div>

      <div className="table-scroll">
        <table className="ledger-table">
          <thead>
            <tr>
              <th>Step</th>
              <th>Actor</th>
              <th>Contract.Method</th>
              <th>Status</th>
              <th>Consensus</th>
              <th>Outcome / Return</th>
              <th>Explorer Tx</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((tx) => (
              <React.Fragment key={tx.txHash}>
                <tr>
                  <td className="mono">{tx.step}</td>
                  <td className="mono muted">{tx.actor}</td>
                  <td className="mono">
                    {tx.contract}.{tx.method}()
                  </td>
                  <td>
                    <span className={`tx-badge ${tx.executionResult === 'SUCCESS' ? 'finalized-success' : 'finalized-error'}`}>
                      {tx.statusName}-{tx.executionResult}
                    </span>
                  </td>
                  <td className="mono muted">{tx.resultName}</td>
                  <td className="mono return-cell" title={String(tx.returnReadable ?? '')}>
                    {String(tx.returnReadable ?? '—').slice(0, 64)}
                  </td>
                  <td>
                    <a href={tx.explorerUrl} target="_blank" rel="noreferrer" className="tx-link mono">
                      {shortHex(tx.txHash, 6, 4)} <ExternalLink size={12} />
                    </a>
                  </td>
                </tr>
                {(tx.emittedChildren || []).map((child, idx) => (
                  <tr key={child.txHash} className="child-row">
                    <td className="mono child-indent" colSpan={2}>
                      <CornerDownRight size={13} /> emit child #{idx + 1}
                    </td>
                    <td className="mono muted">
                      {idx === 0 ? 'VerityCitationJudge (LLM Consensus)' : 'VerityAuditVault callback (on="finalized")'}
                    </td>
                    <td>
                      <span className={`tx-badge ${child.executionResult === 'SUCCESS' ? 'finalized-success' : 'finalized-error'}`}>
                        {child.statusName}-{child.executionResult}
                      </span>
                    </td>
                    <td className="mono muted">{child.resultName}</td>
                    <td className="mono return-cell" title={String(child.returnReadable ?? '')}>
                      {String(child.returnReadable ?? '—').slice(0, 64)}
                    </td>
                    <td>
                      <a href={child.explorerUrl} target="_blank" rel="noreferrer" className="tx-link mono">
                        {shortHex(child.txHash, 6, 4)} <ExternalLink size={12} />
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
