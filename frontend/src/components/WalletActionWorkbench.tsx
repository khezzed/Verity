import React, { useEffect, useState } from 'react';
import { Wallet, Send, RefreshCw, ExternalLink, Clock, ShieldCheck, AlertTriangle } from 'lucide-react';
import type { CorpusRecord, AuditRecord, TrackedTx } from '../types/verity';
import {
  connectStudioNetWallet,
  createWalletClient,
  fetchAccountBalances,
  pollTxPhase,
  sha256HexBrowser,
  shortHex,
  STUDIONET_EXPLORER,
} from '../lib/studionetClient';

const TX_STORAGE_KEY = 'verity_tracked_txs_v1';
const SALT_STORAGE_KEY = 'verity_commit_salts_v1';

const DEFAULT_SAMPLE_MANIFEST = JSON.stringify(
  [
    {
      claim: 'RFC 2104 defines HMAC using ipad equal to 0x36 repeated B times and opad equal to 0x5C repeated B times.',
      source_url: 'https://www.rfc-editor.org/rfc/rfc2104.txt',
      anchor: '0x36',
    },
    {
      claim: 'RFC 8259 specifies that JSON text exchanged outside closed ecosystems MUST be encoded using UTF-8.',
      source_url: 'https://www.rfc-editor.org/rfc/rfc8259.txt',
      anchor: 'UTF-8',
    },
    {
      claim: 'RFC 1321 specifies that MD5 produces a 128-bit fingerprint or message digest.',
      source_url: 'https://www.rfc-editor.org/rfc/rfc1321.txt',
      anchor: '128-bit',
    },
    {
      claim: 'RFC 6962 states that Certificate Transparency logs use a binary Merkle Hash Tree with SHA-256.',
      source_url: 'https://www.rfc-editor.org/rfc/rfc6962.txt',
      anchor: 'SHA-256',
    },
  ],
  null,
  2
);

interface Props {
  vaultAddress: `0x${string}`;
  corpora: CorpusRecord[];
  audits: AuditRecord[];
  onRefreshLive: () => Promise<void>;
}

function loadJsonStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export const WalletActionWorkbench: React.FC<Props> = ({
  vaultAddress,
  corpora,
  audits,
  onRefreshLive,
}) => {
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [balances, setBalances] = useState({ claimable_wei: 0, refundable_wei: 0 });
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [trackedTxs, setTrackedTxs] = useState<TrackedTx[]>(() =>
    loadJsonStorage<TrackedTx[]>(TX_STORAGE_KEY, [])
  );
  const [savedSalts, setSavedSalts] = useState<Record<string, string>>(() =>
    loadJsonStorage<Record<string, string>>(SALT_STORAGE_KEY, {})
  );

  // Form states
  const [activeTab, setActiveTab] = useState<'publish' | 'audit' | 'fallback'>('publish');
  const [title, setTitle] = useState('RFC Cryptography Verification Brief');
  const [rule, setRule] = useState(
    'A claim is SUPPORTED if the cited immutable RFC excerpt explicitly states or directly entails the stated technical definition or parameter.'
  );
  const [profile, setProfile] = useState<'STANDARD_90' | 'HIGH_ASSURANCE_95' | 'STRICT_95'>('STANDARD_90');
  const [bondWei, setBondWei] = useState('20');
  const [entriesJson, setEntriesJson] = useState(DEFAULT_SAMPLE_MANIFEST);

  const [targetCorpusId, setTargetCorpusId] = useState('1');
  const [stakeWei, setStakeWei] = useState('10');
  const [saltInput, setSaltInput] = useState(() => `verity-salt-${Math.floor(Math.random() * 1e9)}`);
  const [targetAuditId, setTargetAuditId] = useState('1');

  useEffect(() => {
    localStorage.setItem(TX_STORAGE_KEY, JSON.stringify(trackedTxs.slice(0, 25)));
  }, [trackedTxs]);

  useEffect(() => {
    localStorage.setItem(SALT_STORAGE_KEY, JSON.stringify(savedSalts));
  }, [savedSalts]);

  // Reload-resumable polling loop every 8s (rate-limit safe for StudioNet 30 req/min)
  useEffect(() => {
    const active = trackedTxs.filter(
      (t) => t.phase === 'submitted' || t.phase === 'pending' || t.phase === 'accepted'
    );
    if (active.length === 0) return;

    const timer = window.setInterval(async () => {
      let anyFinalizedNow = false;
      const updated = await Promise.all(
        trackedTxs.map(async (tx) => {
          if (tx.phase === 'finalized-success' || tx.phase === 'finalized-error') return tx;
          const next = await pollTxPhase(tx.hash);
          if (next.phase === 'finalized-success' || next.phase === 'finalized-error') {
            anyFinalizedNow = true;
          }
          return {
            ...tx,
            phase: next.phase,
            consensusResult: next.consensusResult ?? tx.consensusResult,
            childHashes: next.childHashes ?? tx.childHashes,
            errorDetail: next.errorDetail ?? tx.errorDetail,
            updatedAt: Date.now(),
          };
        })
      );
      setTrackedTxs(updated);
      if (anyFinalizedNow) {
        onRefreshLive().catch(() => undefined);
        if (account) {
          fetchAccountBalances(vaultAddress, account)
            .then(setBalances)
            .catch(() => undefined);
        }
      }
    }, 8000);

    return () => window.clearInterval(timer);
  }, [trackedTxs, account, vaultAddress, onRefreshLive]);

  async function handleConnect() {
    setErrorMsg(null);
    try {
      const addr = await connectStudioNetWallet();
      setAccount(addr);
      const b = await fetchAccountBalances(vaultAddress, addr);
      setBalances(b);
    } catch (err: any) {
      setErrorMsg(err?.message || String(err));
    }
  }

  async function refreshAccount() {
    if (!account) return;
    const b = await fetchAccountBalances(vaultAddress, account);
    setBalances(b);
  }

  async function submitWrite(label: string, functionName: string, args: unknown[], value = 0n) {
    if (!account) {
      setErrorMsg('Connect your StudioNet wallet first.');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    try {
      const client = createWalletClient(account);
      const hash = await client.writeContract({
        address: vaultAddress,
        functionName,
        args: args as any,
        value,
      });
      const now = Date.now();
      setTrackedTxs((prev) => [
        {
          hash: String(hash),
          label,
          phase: 'submitted',
          submittedAt: now,
          updatedAt: now,
        },
        ...prev,
      ]);
    } catch (err: any) {
      setErrorMsg(err?.shortMessage || err?.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handlePublishCorpus(e: React.FormEvent) {
    e.preventDefault();
    try {
      JSON.parse(entriesJson);
    } catch {
      setErrorMsg('Entries JSON is invalid JSON.');
      return;
    }
    await submitWrite(
      `submit_corpus("${title.slice(0, 26)}")`,
      'submit_corpus',
      [title, rule, profile, entriesJson, 3600n, 300n, 3600n],
      BigInt(bondWei || '20')
    );
  }

  async function handleCommitAudit() {
    const commitHash = await sha256HexBrowser(saltInput);
    setSavedSalts((prev) => ({ ...prev, [`corpus_${targetCorpusId}`]: saltInput }));
    await submitWrite(
      `commit_audit(corpus #${targetCorpusId})`,
      'commit_audit',
      [BigInt(targetCorpusId), commitHash],
      BigInt(stakeWei || '10')
    );
  }

  async function handleRevealSeed() {
    await submitWrite(`reveal_audit_seed(audit #${targetAuditId})`, 'reveal_audit_seed', [
      BigInt(targetAuditId),
      saltInput,
    ]);
  }

  async function handleStepSample() {
    await submitWrite(`step_audit_sample(audit #${targetAuditId})`, 'step_audit_sample', [
      BigInt(targetAuditId),
    ]);
  }

  const openCorpora = corpora.filter((c) => c.status === 'OPEN_FOR_AUDIT');
  const activeAudits = audits.filter((a) => a.status === 'COMMITTED' || a.status === 'ACTIVE');

  return (
    <div className="panel workbench-panel">
      <div className="panel-header">
        <div>
          <h3 className="panel-title">Interactive StudioNet Wallet Workbench (Chain 61999)</h3>
          <p className="panel-subtitle">
            Optional wallet connection for live end-to-end transactions: Publish Corpus, Commit/Reveal Audit Seed, Step Wald SPRT Samples, Claim Winnings, and Withdraw Refunds.
          </p>
        </div>

        <div className="wallet-controls">
          {account ? (
            <>
              <span className="wallet-pill mono">
                <Wallet size={14} /> {shortHex(account, 6, 4)}
              </span>
              <button type="button" className="btn-secondary" onClick={refreshAccount}>
                <RefreshCw size={14} /> Balances
              </button>
            </>
          ) : (
            <button type="button" className="btn-primary" onClick={handleConnect}>
              <Wallet size={15} /> Connect Wallet (StudioNet)
            </button>
          )}
        </div>
      </div>

      {account && (
        <div className="balance-strip">
          <div className="balance-item">
            <span className="mini-label">Claimable Winnings</span>
            <span className="mono balance-amt accent-emerald">{balances.claimable_wei} wei</span>
            <button
              type="button"
              className="btn-small"
              disabled={busy || balances.claimable_wei === 0}
              onClick={() => submitWrite('claim_winnings()', 'claim_winnings', [])}
            >
              Claim Winnings
            </button>
          </div>
          <div className="balance-item">
            <span className="mini-label">Refundable Balance</span>
            <span className="mono balance-amt accent-amber">{balances.refundable_wei} wei</span>
            <button
              type="button"
              className="btn-small"
              disabled={busy || balances.refundable_wei === 0}
              onClick={() => submitWrite('withdraw_refund()', 'withdraw_refund', [])}
            >
              Withdraw Refund
            </button>
          </div>
        </div>
      )}

      {errorMsg && (
        <div className="alert-banner error">
          <AlertTriangle size={15} /> {errorMsg}
        </div>
      )}

      <div className="subtabs">
        <button
          type="button"
          className={`subtab ${activeTab === 'publish' ? 'active' : ''}`}
          onClick={() => setActiveTab('publish')}
        >
          1. Publish Corpus + Bond
        </button>
        <button
          type="button"
          className={`subtab ${activeTab === 'audit' ? 'active' : ''}`}
          onClick={() => setActiveTab('audit')}
        >
          2. Commit / Reveal / Step SPRT ({openCorpora.length} open, {activeAudits.length} active)
        </button>
        <button
          type="button"
          className={`subtab ${activeTab === 'fallback' ? 'active' : ''}`}
          onClick={() => setActiveTab('fallback')}
        >
          3. Deterministic Fallbacks
        </button>
      </div>

      {activeTab === 'publish' && (
        <form className="wb-form" onSubmit={handlePublishCorpus}>
          <div className="form-grid-2">
            <label className="field">
              <span>Domain Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} required />
            </label>
            <div className="form-grid-2">
              <label className="field">
                <span>SPRT Profile</span>
                <select value={profile} onChange={(e) => setProfile(e.target.value as any)}>
                  <option value="STANDARD_90">STANDARD_90 (4 pass / 2 fail)</option>
                  <option value="HIGH_ASSURANCE_95">HIGH_ASSURANCE_95 (6 pass / 2 fail)</option>
                  <option value="STRICT_95">STRICT_95 (8 pass / 2 fail)</option>
                </select>
              </label>
              <label className="field">
                <span>Veracity Bond (wei, ≥ 2)</span>
                <input value={bondWei} onChange={(e) => setBondWei(e.target.value)} type="number" min={2} required />
              </label>
            </div>
          </div>
          <label className="field">
            <span>Grounding Rule (vetted up-front by GenLayer RuleGate)</span>
            <input value={rule} onChange={(e) => setRule(e.target.value)} required />
          </label>
          <label className="field">
            <span>Immutable Entries JSON (RFC, Wikipedia revids API, pinned GitHub 40-hex SHA, or Archive.org id_)</span>
            <textarea rows={6} className="mono" value={entriesJson} onChange={(e) => setEntriesJson(e.target.value)} />
          </label>
          <button type="submit" className="btn-primary" disabled={busy || !account}>
            <Send size={14} /> Submit Corpus & Trigger RuleGate
          </button>
        </form>
      )}

      {activeTab === 'audit' && (
        <div className="wb-form">
          <div className="form-grid-3">
            <label className="field">
              <span>Corpus ID to Challenge</span>
              <input value={targetCorpusId} onChange={(e) => setTargetCorpusId(e.target.value)} type="number" min={1} />
            </label>
            <label className="field">
              <span>Auditor Stake (wei)</span>
              <input value={stakeWei} onChange={(e) => setStakeWei(e.target.value)} type="number" min={1} />
            </label>
            <label className="field">
              <span>Commit-Reveal Salt (auto-saved locally)</span>
              <input className="mono" value={saltInput} onChange={(e) => setSaltInput(e.target.value)} />
            </label>
          </div>
          <div className="action-row">
            <button type="button" className="btn-primary" disabled={busy || !account} onClick={handleCommitAudit}>
              1. Commit Audit Seed Hash + Stake
            </button>
          </div>

          <hr className="divider" />

          <div className="form-grid-2">
            <label className="field">
              <span>Audit ID to Reveal / Step</span>
              <input value={targetAuditId} onChange={(e) => setTargetAuditId(e.target.value)} type="number" min={1} />
            </label>
            <div className="action-row align-end">
              <button type="button" className="btn-secondary" disabled={busy || !account} onClick={handleRevealSeed}>
                2. Reveal Salt → Freeze Fisher-Yates Order
              </button>
              <button type="button" className="btn-primary" disabled={busy || !account} onClick={handleStepSample}>
                3. Step Next SPRT Sample (1 LLM Verdict)
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'fallback' && (
        <div className="wb-form">
          <p className="panel-subtitle">
            Every waiting state has a deterministic permissionless fallback so funds can never lock forever if a party stalls or consensus drops.
          </p>
          <div className="form-grid-2">
            <label className="field">
              <span>Corpus ID</span>
              <input value={targetCorpusId} onChange={(e) => setTargetCorpusId(e.target.value)} type="number" min={1} />
            </label>
            <label className="field">
              <span>Audit ID</span>
              <input value={targetAuditId} onChange={(e) => setTargetAuditId(e.target.value)} type="number" min={1} />
            </label>
          </div>
          <div className="action-row wrap">
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || !account}
              onClick={() => submitWrite(`reclaim_stalled_vetting(#${targetCorpusId})`, 'reclaim_stalled_vetting', [BigInt(targetCorpusId)])}
            >
              Reclaim Stalled Vetting
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || !account}
              onClick={() => submitWrite(`close_unchallenged_corpus(#${targetCorpusId})`, 'close_unchallenged_corpus', [BigInt(targetCorpusId)])}
            >
              Close Unchallenged Corpus
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || !account}
              onClick={() => submitWrite(`expire_unrevealed_audit(#${targetAuditId})`, 'expire_unrevealed_audit', [BigInt(targetAuditId)])}
            >
              Expire Unrevealed Audit (10% Anti-Grief)
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || !account}
              onClick={() => submitWrite(`expire_stalled_audit(#${targetAuditId})`, 'expire_stalled_audit', [BigInt(targetAuditId)])}
            >
              Expire Stalled Audit (Grace Fallback)
            </button>
          </div>
        </div>
      )}

      {trackedTxs.length > 0 && (
        <div className="tx-tracker">
          <div className="tx-tracker-head">
            <span className="drawer-label">Reload-Resumable StudioNet Transaction Tracker (8s poll)</span>
            <button type="button" className="btn-link" onClick={() => setTrackedTxs([])}>
              Clear
            </button>
          </div>
          <div className="tx-tracker-list">
            {trackedTxs.map((t) => (
              <div key={t.hash} className="tracked-tx-row">
                <div className="tracked-tx-main">
                  <span className={`tx-badge ${t.phase}`}>{t.phase}</span>
                  <span className="mono">{t.label}</span>
                  <a
                    href={`${STUDIONET_EXPLORER}/transactions/${t.hash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="tx-link mono"
                  >
                    {shortHex(t.hash, 6, 4)} <ExternalLink size={12} />
                  </a>
                </div>
                {t.phase === 'accepted' && (
                  <div className="appeal-note">
                    <Clock size={13} /> GenLayer native appeal window open — settlement waits for <code>emit(on=&quot;finalized&quot;)</code>.
                  </div>
                )}
                {t.phase === 'finalized-success' && (
                  <div className="finalized-note">
                    <ShieldCheck size={13} /> Finalized ({t.consensusResult || 'MAJORITY_AGREE'})
                    {t.childHashes && t.childHashes.length > 0 ? ` • ${t.childHashes.length} emitted callback(s)` : ''}
                  </div>
                )}
                {t.errorDetail && <div className="error-note">{t.errorDetail}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
