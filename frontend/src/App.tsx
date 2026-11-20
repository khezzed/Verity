import React, { useCallback, useMemo, useState } from 'react';
import {
  Activity,
  FileSpreadsheet,
  Wallet,
  ExternalLink,
  RefreshCw,
  Menu,
  X,
} from 'lucide-react';
import recordedProofRaw from './data/proof.json';
import type { ProofManifest } from './types/verity';
import { fetchLiveSnapshot, shortHex } from './lib/studionetClient';
import { SprtTrajectoryChart } from './components/SprtTrajectoryChart';
import { CorpusSamplingMatrix } from './components/CorpusSamplingMatrix';
import { FinalizedLedgerTable } from './components/FinalizedLedgerTable';
import { WalletActionWorkbench } from './components/WalletActionWorkbench';

const RECORDED_PROOF = recordedProofRaw as unknown as ProofManifest;

type WorkspaceView = 'instrument' | 'ledger' | 'wallet';

function statusMeta(status: string): { label: string; tone: 'certify' | 'reject' | 'pending' } {
  switch (status) {
    case 'CERTIFIED_SOUND':
      return { label: 'Certified sound', tone: 'certify' };
    case 'REJECTED_DEFECTIVE':
      return { label: 'Rejected defective', tone: 'reject' };
    case 'REJECTED_VAGUE':
      return { label: 'Rejected vague rule', tone: 'reject' };
    case 'OPEN_FOR_AUDIT':
      return { label: 'Open for audit', tone: 'pending' };
    case 'AUDIT_EXPIRED_REFUNDED':
      return { label: 'Expired refunded', tone: 'pending' };
    default:
      return { label: status.replace(/_/g, ' ').toLowerCase(), tone: 'pending' };
  }
}

export function App() {
  const [view, setView] = useState<WorkspaceView>('instrument');
  const [mobileRailOpen, setMobileRailOpen] = useState(false);

  const [dataMode, setDataMode] = useState<'recorded' | 'live'>('recorded');
  const [liveData, setLiveData] = useState<{
    protocolInfo: ProofManifest['onChainState']['protocolInfo'];
    judgeInfo: ProofManifest['onChainState']['judgeInfo'];
    corpora: ProofManifest['onChainState']['corpora'];
    audits: ProofManifest['onChainState']['audits'];
    fetchedAt: string;
  } | null>(null);
  const [loadingLive, setLoadingLive] = useState(false);
  const [liveErr, setLiveErr] = useState<string | null>(null);

  const activeState = dataMode === 'live' && liveData ? liveData : RECORDED_PROOF.onChainState;
  const corpora = activeState.corpora;
  const audits = activeState.audits;

  const defaultCorpusId = useMemo(() => {
    const sound = corpora.find((c) => c.status === 'CERTIFIED_SOUND');
    return sound ? sound.corpus_id : corpora[0]?.corpus_id ?? 1;
  }, [corpora]);

  const [selectedCorpusId, setSelectedCorpusId] = useState<number>(defaultCorpusId);
  const [selectedEntryIdx, setSelectedEntryIdx] = useState<number | null>(null);
  const [ledgerFilter, setLedgerFilter] = useState<string>('all');

  const activeCorpus = corpora.find((c) => c.corpus_id === selectedCorpusId) || corpora[0] || null;
  const corpusAudits = useMemo(
    () => (activeCorpus ? audits.filter((a) => a.corpus_id === activeCorpus.corpus_id) : []),
    [audits, activeCorpus]
  );
  const latestAudit = corpusAudits.length > 0 ? corpusAudits[corpusAudits.length - 1] : null;

  const vaultAddr = RECORDED_PROOF.contracts.verityAuditVault.address as `0x${string}`;
  const judgeAddr = RECORDED_PROOF.contracts.verityCitationJudge.address as `0x${string}`;

  const handleRefreshLive = useCallback(async () => {
    setLoadingLive(true);
    setLiveErr(null);
    try {
      const snap = await fetchLiveSnapshot(vaultAddr, judgeAddr);
      setLiveData(snap);
      setDataMode('live');
    } catch (err: any) {
      setLiveErr(err?.message || String(err));
    } finally {
      setLoadingLive(false);
    }
  }, [vaultAddr, judgeAddr]);

  const totalFinalizedTxs = useMemo(() => {
    let n = 2;
    for (const tx of RECORDED_PROOF.transactions) {
      n += 1 + (tx.emittedChildren?.length || 0);
    }
    return n;
  }, []);

  const activeStatus = activeCorpus ? statusMeta(activeCorpus.status) : null;

  return (
    <div className="workspace-shell">
      {/* Mobile Header Bar */}
      <div className="mobile-bar">
        <span className="brand-wordmark" style={{ fontSize: '1.35rem' }}>
          Verity
        </span>
        <button
          type="button"
          className="btn-secondary"
          style={{ padding: '6px 10px' }}
          onClick={() => setMobileRailOpen((o) => !o)}
          aria-label="Toggle audit navigation"
        >
          {mobileRailOpen ? <X size={16} /> : <Menu size={16} />}
        </button>
      </div>

      {mobileRailOpen && (
        <div className="mobile-backdrop" onClick={() => setMobileRailOpen(false)} aria-hidden="true" />
      )}

      {/* Persistent Oxford Navy Navigation Rail */}
      <aside className={`rail ${mobileRailOpen ? 'open' : ''}`} aria-label="Protocol navigation">
        <div className="rail-brand">
          <span className="brand-wordmark">Verity</span>
          <span className="brand-chain">StudioNet 61999</span>
        </div>

        <div className="rail-section">
          <p className="rail-section-title">Workspace</p>
          <div className="rail-nav-list">
            <button
              type="button"
              className={`rail-nav-btn ${view === 'instrument' ? 'active' : ''}`}
              onClick={() => {
                setView('instrument');
                setMobileRailOpen(false);
              }}
            >
              <span className="rail-nav-left">
                <Activity size={15} /> Audit instrument
              </span>
              <span className="rail-nav-count">{corpora.length}</span>
            </button>
            <button
              type="button"
              className={`rail-nav-btn ${view === 'ledger' ? 'active' : ''}`}
              onClick={() => {
                setView('ledger');
                setMobileRailOpen(false);
              }}
            >
              <span className="rail-nav-left">
                <FileSpreadsheet size={15} /> Finalized ledger
              </span>
              <span className="rail-nav-count">{totalFinalizedTxs}</span>
            </button>
            <button
              type="button"
              className={`rail-nav-btn ${view === 'wallet' ? 'active' : ''}`}
              onClick={() => {
                setView('wallet');
                setMobileRailOpen(false);
              }}
            >
              <span className="rail-nav-left">
                <Wallet size={15} /> Wallet workbench
              </span>
            </button>
          </div>
        </div>

        <div className="rail-section">
          <p className="rail-section-title">Audited corpora</p>
          <div className="rail-nav-list">
            {corpora.map((c) => {
              const sm = statusMeta(c.status);
              const cAudits = audits.filter((a) => a.corpus_id === c.corpus_id);
              const lastA = cAudits[cAudits.length - 1];
              const sampled = lastA ? lastA.samples.length : 0;
              return (
                <button
                  key={c.corpus_id}
                  type="button"
                  className={`corpus-rail-item ${
                    view === 'instrument' && activeCorpus?.corpus_id === c.corpus_id ? 'active' : ''
                  }`}
                  onClick={() => {
                    setSelectedCorpusId(c.corpus_id);
                    setSelectedEntryIdx(null);
                    setView('instrument');
                    setMobileRailOpen(false);
                  }}
                >
                  <div className="corpus-rail-top">
                    <span className="corpus-rail-id">
                      <span className={`status-dot ${sm.tone}`} />
                      Corpus {c.corpus_id}
                    </span>
                    <span className="corpus-rail-meta">
                      {sampled}/{c.entry_count}
                    </span>
                  </div>
                  <span className="corpus-rail-name">{c.domain_title}</span>
                  <span className="corpus-rail-meta">{sm.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="rail-footer">
          <div className="segmented" role="group" aria-label="State read source">
            <button
              type="button"
              className={dataMode === 'recorded' ? 'active' : ''}
              onClick={() => setDataMode('recorded')}
            >
              Recorded proof
            </button>
            <button
              type="button"
              className={dataMode === 'live' ? 'active' : ''}
              disabled={loadingLive}
              onClick={handleRefreshLive}
            >
              {loadingLive ? 'Reading...' : 'Live RPC'}
            </button>
          </div>

          <div className="rail-invariant">
            <div className="rail-invariant-head">
              <span>Vault conservation</span>
              <span className="rail-invariant-ok">
                {activeState.protocolInfo.conservation_ok ? 'Exact' : 'Check'}
              </span>
            </div>
            <span className="rail-invariant-nums">
              {activeState.protocolInfo.total_inbound_wei} in · {activeState.protocolInfo.total_outbound_wei} out ·{' '}
              {activeState.protocolInfo.contract_balance_wei} wei locked
            </span>
          </div>

          <div className="rail-links">
            <a
              href={RECORDED_PROOF.contracts.verityAuditVault.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="rail-link"
            >
              <span>Vault {shortHex(vaultAddr, 4, 4)}</span>
              <ExternalLink size={12} />
            </a>
            <a
              href={RECORDED_PROOF.contracts.verityCitationJudge.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="rail-link"
            >
              <span>Judge {shortHex(judgeAddr, 4, 4)}</span>
              <ExternalLink size={12} />
            </a>
          </div>
        </div>
      </aside>

      {/* Main Instrument Canvas */}
      <main className="workspace-main">
        {view === 'instrument' && activeCorpus && activeStatus && (
          <>
            <header className="page-header">
              <div className="page-header-main">
                <h1 className="page-title">{activeCorpus.domain_title}</h1>
                <p className="page-meta-line">
                  <span className={`outcome-text ${activeStatus.tone}`}>{activeStatus.label}</span>
                  <span>Profile {activeCorpus.profile_id}</span>
                  <span>RuleGate: {activeCorpus.vetting_reason || 'Pending'}</span>
                  <span>
                    {dataMode === 'live' && liveData
                      ? `Live RPC (${liveData.fetchedAt.slice(11, 19)} UTC)`
                      : 'Recorded proof (proof.json)'}
                  </span>
                </p>
              </div>

              <div className="header-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={loadingLive}
                  onClick={handleRefreshLive}
                >
                  <RefreshCw size={14} /> {loadingLive ? 'Syncing...' : 'Verify live'}
                </button>
              </div>
            </header>

            {liveErr && (
              <div className="error-inline" style={{ marginBottom: 18 }}>
                Live StudioNet read failed: {liveErr}
              </div>
            )}

            {/* Single Unified Primary Sheet: SPRT Trajectory + Split Citation Index & Monograph */}
            <section className="instrument-sheet" aria-label="Sequential audit analysis">
              {latestAudit && latestAudit.sample_order.length > 0 ? (
                <SprtTrajectoryChart
                  audit={latestAudit}
                  totalEntries={activeCorpus.entry_count}
                  selectedEntryIdx={selectedEntryIdx}
                  onSelectEntry={setSelectedEntryIdx}
                />
              ) : (
                <div className="sheet-band">
                  <div className="band-header" style={{ marginBottom: 0 }}>
                    <div>
                      <h2 className="section-heading">
                        {activeCorpus.status === 'REJECTED_VAGUE'
                          ? 'Stopped at up-front RuleGate'
                          : 'Awaiting revealed audit seed'}
                      </h2>
                      <p className="section-desc">
                        {activeCorpus.status === 'REJECTED_VAGUE'
                          ? 'Validators rejected the grounding rule as subjective before the corpus could open. 100% of the publisher bond was returned to refundable balances.'
                          : `Audits recorded on this corpus: ${corpusAudits
                              .map((a) => `Audit ${a.audit_id} (${a.status.toLowerCase().replace(/_/g, ' ')})`)
                              .join(', ')}. Bond currently locked: ${activeCorpus.bond_wei} wei (open for challenge in Wallet workbench).`}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="sheet-band" style={{ padding: 0 }}>
                <CorpusSamplingMatrix
                  corpus={activeCorpus}
                  audit={latestAudit}
                  selectedEntryIdx={selectedEntryIdx}
                  onSelectEntry={setSelectedEntryIdx}
                />
              </div>

              <div className="rule-footer-grid">
                <div>
                  <span className="kv-label">Frozen grounding rule</span>
                  <p>{activeCorpus.grounding_rule}</p>
                </div>
                <div>
                  <span className="kv-label">GenLayer finality and appeal window</span>
                  <p>
                    Every validator verdict returns via <code className="code-hex">emit(on=&quot;finalized&quot;)</code>.
                    No SPRT step, bond slash, or withdrawal executes while a transaction is provisionally accepted.
                  </p>
                </div>
              </div>
            </section>
          </>
        )}

        {view === 'ledger' && (
          <>
            <header className="page-header">
              <div>
                <h1 className="page-title">StudioNet proof ledger</h1>
                <p className="page-meta-line">
                  <span>{totalFinalizedTxs} finalized transactions on Chain 61999</span>
                  <span className="meta-sep" aria-hidden="true">/</span>
                  <span>
                    Judge <code className="code-hex">{activeState.judgeInfo.vettings_completed}</code> RuleGates and{' '}
                    <code className="code-hex">{activeState.judgeInfo.samples_judged}</code> citation samples
                  </span>
                  <span className="meta-sep" aria-hidden="true">/</span>
                  <span>Source commit <code className="code-hex">{RECORDED_PROOF.sourceCommit.slice(0, 7)}</code></span>
                </p>
              </div>
            </header>

            <FinalizedLedgerTable
              transactions={RECORDED_PROOF.transactions}
              filterCaseId={ledgerFilter}
              onChangeFilter={setLedgerFilter}
            />
          </>
        )}

        {view === 'wallet' && (
          <>
            <header className="page-header">
              <div>
                <h1 className="page-title">Wallet workbench</h1>
                <p className="page-meta-line">
                  <span>Vault contract <code className="code-hex">{vaultAddr}</code></span>
                  <span className="meta-sep" aria-hidden="true">/</span>
                  <span>GenLayer StudioNet (Chain 61999)</span>
                </p>
              </div>
            </header>

            <WalletActionWorkbench
              vaultAddress={vaultAddr}
              corpora={corpora}
              audits={audits}
              onRefreshLive={handleRefreshLive}
            />
          </>
        )}
      </main>
    </div>
  );
}

export default App;
