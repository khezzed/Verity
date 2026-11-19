import React, { useCallback, useMemo, useState } from 'react';
import {
  ShieldCheck,
  Radio,
  Database,
  RefreshCw,
  ExternalLink,
  Scale,
  CheckCircle2,
  XCircle,
  Clock,
  Layers,
} from 'lucide-react';
import recordedProofRaw from './data/proof.json';
import type { ProofManifest } from './types/verity';
import { fetchLiveSnapshot, shortHex, STUDIONET_EXPLORER } from './lib/studionetClient';
import { SprtTrajectoryChart } from './components/SprtTrajectoryChart';
import { CorpusSamplingMatrix } from './components/CorpusSamplingMatrix';
import { FinalizedLedgerTable } from './components/FinalizedLedgerTable';
import { WalletActionWorkbench } from './components/WalletActionWorkbench';

const RECORDED_PROOF = recordedProofRaw as unknown as ProofManifest;

export function App() {
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

  // Default to the Sound Certified corpus (#2) if present, else first corpus
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
    let n = 2; // Judge + Vault deployments
    for (const tx of RECORDED_PROOF.transactions) {
      n += 1 + (tx.emittedChildren?.length || 0);
    }
    return n;
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="brand-eyebrow">
            <Scale size={14} /> GenLayer Intelligent Contracts • Risk-Limiting Audit Protocol
          </div>
          <h1 className="brand-title">Verity</h1>
          <p className="brand-sub">
            On-chain <strong>Wald Sequential Probability Ratio Test (SPRT)</strong> for batch factual citation grounding.
            Commit-reveal Fisher-Yates draws prevent cherry-picking; GenLayer validators verify verbatim quotes inside
            bounded immutable third-party slices; plain deterministic code stops early and settles GEN strictly on{' '}
            <code>emit(on=&quot;finalized&quot;)</code>.
          </p>
        </div>

        <div className="source-mode-box">
          <span className={`mode-badge ${dataMode}`}>
            {dataMode === 'live' ? (
              <>
                <Radio size={13} /> Live StudioNet RPC Read ({liveData?.fetchedAt.slice(11, 19)} UTC)
              </>
            ) : (
              <>
                <Database size={13} /> Recorded Finalized Proof (deploy/proof.json)
              </>
            )}
          </span>
          <div className="mode-actions">
            <button
              type="button"
              className="btn-secondary"
              disabled={loadingLive}
              onClick={handleRefreshLive}
            >
              <RefreshCw size={14} /> {loadingLive ? 'Querying StudioNet…' : 'Read Live from StudioNet'}
            </button>
            {dataMode === 'live' && (
              <button type="button" className="btn-small" onClick={() => setDataMode('recorded')}>
                Switch to Recorded Proof
              </button>
            )}
          </div>
          {liveErr && <span className="error-note">{liveErr}</span>}
        </div>
      </header>

      <section className="kpi-strip">
        <div className="kpi-card">
          <span className="kpi-label">VerityAuditVault (Deterministic)</span>
          <div className="kpi-val mono">
            <a href={RECORDED_PROOF.contracts.verityAuditVault.explorerUrl} target="_blank" rel="noreferrer" className="tx-link">
              {shortHex(vaultAddr, 6, 4)} <ExternalLink size={13} />
            </a>
          </div>
          <div className="kpi-foot mono">
            {activeState.protocolInfo.corpus_count} corpora • {activeState.protocolInfo.audit_count} audits
          </div>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">VerityCitationJudge (LLM Oracle)</span>
          <div className="kpi-val mono">
            <a href={RECORDED_PROOF.contracts.verityCitationJudge.explorerUrl} target="_blank" rel="noreferrer" className="tx-link">
              {shortHex(judgeAddr, 6, 4)} <ExternalLink size={13} />
            </a>
          </div>
          <div className="kpi-foot mono">
            {activeState.judgeInfo.vettings_completed} RuleGates • {activeState.judgeInfo.samples_judged} samples judged
          </div>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">Conservation Invariant</span>
          <div className="kpi-val">
            {activeState.protocolInfo.conservation_ok ? (
              <span className="accent-emerald" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ShieldCheck size={18} /> 100% Conserved
              </span>
            ) : (
              <span className="accent-crimson">Violation</span>
            )}
          </div>
          <div className="kpi-foot mono">
            in={activeState.protocolInfo.total_inbound_wei} • out={activeState.protocolInfo.total_outbound_wei} • bal={activeState.protocolInfo.contract_balance_wei} wei
          </div>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">Recorded Finalized Proofs</span>
          <div className="kpi-val mono">
            <Layers size={17} className="accent-emerald" /> {totalFinalizedTxs} Finalized Txs
          </div>
          <div className="kpi-foot">StudioNet Chain 61999 • No wallet needed to inspect</div>
        </div>
      </section>

      <div className="appeal-banner">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Clock size={16} className="accent-amber" />
          <span>
            <strong>GenLayer Native Appeal Window Enforced:</strong> Every validator judgment in{' '}
            <code>VerityCitationJudge</code> returns to <code>VerityAuditVault</code> strictly via{' '}
            <code>emit(on=&quot;finalized&quot;)</code>. No SPRT update, slash, or GEN payout executes while a
            transaction is merely <code>ACCEPTED</code>.
          </span>
        </div>
        <span className="mono muted">Runner: {RECORDED_PROOF.network.pinnedRunner.slice(0, 28)}…</span>
      </div>

      {/* Case Selector Tabs */}
      <nav className="case-tabs" aria-label="Audited Corpora">
        {corpora.map((c) => {
          const isCert = c.status === 'CERTIFIED_SOUND';
          const isRej = c.status === 'REJECTED_DEFECTIVE' || c.status === 'REJECTED_VAGUE';
          return (
            <button
              key={c.corpus_id}
              type="button"
              className={`case-tab ${activeCorpus?.corpus_id === c.corpus_id ? 'active' : ''}`}
              onClick={() => {
                setSelectedCorpusId(c.corpus_id);
                setSelectedEntryIdx(null);
              }}
            >
              {isCert ? (
                <CheckCircle2 size={14} className="accent-emerald" />
              ) : isRej ? (
                <XCircle size={14} className="accent-crimson" />
              ) : (
                <Clock size={14} className="accent-amber" />
              )}
              <span>
                Corpus #{c.corpus_id}: {c.domain_title.slice(0, 34)}
                {c.domain_title.length > 34 ? '…' : ''}
              </span>
              <span className={`status-pill ${c.status.toLowerCase()}`}>{c.status}</span>
            </button>
          );
        })}
      </nav>

      {/* Active Corpus Overview */}
      {activeCorpus && (
        <section className="panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                Corpus #{activeCorpus.corpus_id} — {activeCorpus.domain_title}
              </h2>
              <p className="panel-subtitle">
                Publisher <span className="mono">{shortHex(activeCorpus.publisher, 6, 4)}</span> • SPRT Profile{' '}
                <strong className="mono">{activeCorpus.profile_id}</strong> • RuleGate:{' '}
                <strong className="mono">{activeCorpus.vetting_reason || 'PENDING'}</strong>
              </p>
            </div>
            <span className={`status-pill ${activeCorpus.status.toLowerCase()}`}>{activeCorpus.status}</span>
          </div>

          <div className="rule-box">
            <span className="drawer-label">Frozen Grounding Rule (Vetted Up-Front by RuleGate)</span>
            {activeCorpus.grounding_rule}
          </div>

          <div className="corpus-banner-meta mono">
            <div>
              <span className="drawer-label">Entries</span>
              {activeCorpus.entry_count} immutable citations
            </div>
            <div>
              <span className="drawer-label">Audits Run</span>
              {corpusAudits.length} ({corpusAudits.map((a) => `#${a.audit_id}:${a.status}`).join(', ') || 'None (RuleGate rejected)'})
            </div>
            <div>
              <span className="drawer-label">Min Audit Stake</span>
              {activeCorpus.min_audit_stake_wei} wei
            </div>
            <div>
              <span className="drawer-label">Active Locked Bond</span>
              {activeCorpus.bond_wei} wei
            </div>
          </div>
        </section>
      )}

      {/* Interactive SPRT Chart when an audit with revealed samples exists */}
      {activeCorpus && latestAudit && latestAudit.sample_order.length > 0 && (
        <SprtTrajectoryChart
          audit={latestAudit}
          totalEntries={activeCorpus.entry_count}
          selectedEntryIdx={selectedEntryIdx}
          onSelectEntry={setSelectedEntryIdx}
        />
      )}

      {/* Corpus Sampling Matrix & Verbatim Quote Evidence Drawer */}
      {activeCorpus && (
        <CorpusSamplingMatrix
          corpus={activeCorpus}
          audit={latestAudit}
          selectedEntryIdx={selectedEntryIdx}
          onSelectEntry={setSelectedEntryIdx}
        />
      )}

      {/* Finalized Transaction Ledger */}
      <div style={{ marginBottom: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="drawer-label" style={{ margin: 0 }}>Filter Proof Ledger:</span>
        {[
          { id: 'all', label: 'All Recorded Txs' },
          { id: 'case0_payable_guard', label: 'Case 0: Payable Guard' },
          { id: 'case1_rulegate_reject', label: 'Case 1: RuleGate Reject' },
          { id: 'case2_certified_sound', label: 'Case 2: Certified Sound (SPRT)' },
          { id: 'case3_rejected_defective', label: 'Case 3: Rejected + Injection' },
          { id: 'case4_deterministic_fallbacks', label: 'Case 4: Anti-Grief & Timeout' },
        ].map((f) => (
          <button
            key={f.id}
            type="button"
            className={`subtab ${ledgerFilter === f.id ? 'active' : ''}`}
            onClick={() => setLedgerFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <FinalizedLedgerTable transactions={RECORDED_PROOF.transactions} filterCaseId={ledgerFilter} />

      {/* Interactive Wallet Workbench */}
      <WalletActionWorkbench
        vaultAddress={vaultAddr}
        corpora={corpora}
        audits={audits}
        onRefreshLive={handleRefreshLive}
      />

      <footer className="footer-bar mono">
        <span>Verity • GenLayer StudioNet (Chain 61999)</span>
        <span>
          Vault SHA-256: {RECORDED_PROOF.contracts.verityAuditVault.sourceSha256.slice(0, 16)}… • Judge SHA-256:{' '}
          {RECORDED_PROOF.contracts.verityCitationJudge.sourceSha256.slice(0, 16)}…
        </span>
        <a href={STUDIONET_EXPLORER} target="_blank" rel="noreferrer" className="tx-link">
          StudioNet Explorer <ExternalLink size={12} />
        </a>
      </footer>
    </div>
  );
}

export default App;
