import React, { useEffect, useState } from 'react';
import { Wallet, Send, RefreshCw, ExternalLink, AlertCircle } from 'lucide-react';
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

const TX_STORAGE_KEY = 'verity_tracked_txs_v2';
const SALT_STORAGE_KEY = 'verity_commit_salts_v2';

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

  const [actionMode, setActionMode] = useState<'publish' | 'audit' | 'fallback'>('publish');
  const [title, setTitle] = useState('RFC Cryptography Verification Brief');
  const [rule, setRule] = useState(
    'A claim is SUPPORTED if the cited immutable RFC excerpt explicitly states or directly entails the stated technical definition or parameter.'
  );
  const [profile, setProfile] = useState<'STANDARD_90' | 'HIGH_ASSURANCE_95' | 'STRICT_95'>('STANDARD_90');
  const [bondWei, setBondWei] = useState('20');
  const [entriesJson, setEntriesJson] = useState(DEFAULT_SAMPLE_MANIFEST);

  const openCorpora = corpora.filter((c) => c.status === 'OPEN_FOR_AUDIT');
  const [targetCorpusId, setTargetCorpusId] = useState(() => String(openCorpora[0]?.corpus_id ?? 4));
  const [stakeWei, setStakeWei] = useState('25');
  const [saltInput, setSaltInput] = useState(() => `verity-salt-${Math.floor(Math.random() * 1e9)}`);
  const [targetAuditId, setTargetAuditId] = useState(() => String(audits[audits.length - 1]?.audit_id ?? 1));

  useEffect(() => {
    localStorage.setItem(TX_STORAGE_KEY, JSON.stringify(trackedTxs.slice(0, 25)));
  }, [trackedTxs]);

  useEffect(() => {
    localStorage.setItem(SALT_STORAGE_KEY, JSON.stringify(savedSalts));
  }, [savedSalts]);

  useEffect(() => {
    const active = trackedTxs.filter(
      (t) => t.phase === 'submitted' || t.phase === 'pending' || t.phase === 'accepted'
    );
    if (active.length === 0) return;

    const timer = window.setInterval(async () => {
      let anyFinalized = false;
      const nextList = await Promise.all(
        trackedTxs.map(async (tx) => {
          if (tx.phase === 'finalized-success' || tx.phase === 'finalized-error') return tx;
          const res = await pollTxPhase(tx.hash);
          if (res.phase === 'finalized-success' || res.phase === 'finalized-error') {
            anyFinalized = true;
          }
          return {
            ...tx,
            phase: res.phase,
            consensusResult: res.consensusResult ?? tx.consensusResult,
            childHashes: res.childHashes ?? tx.childHashes,
            errorDetail: res.errorDetail ?? tx.errorDetail,
            updatedAt: Date.now(),
          };
        })
      );
      setTrackedTxs(nextList);
      if (anyFinalized) {
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
      setBalances(await fetchAccountBalances(vaultAddress, addr));
    } catch (err: any) {
      setErrorMsg(err?.message || String(err));
    }
  }

  async function refreshAccount() {
    if (!account) return;
    setBalances(await fetchAccountBalances(vaultAddress, account));
  }

  async function submitWrite(label: string, functionName: string, args: unknown[], value = 0n) {
    if (!account) {
      setErrorMsg('Connect your StudioNet wallet before submitting transactions.');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    try {
      const client = await createWalletClient(account);
      const hash = await client.writeContract({
        address: vaultAddress,
        functionName,
        args: args as any,
        value,
      });
      const now = Date.now();
      setTrackedTxs((prev) => [
        { hash: String(hash), label, phase: 'submitted', submittedAt: now, updatedAt: now },
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
      setErrorMsg('Entries JSON could not be parsed. Fix syntax errors and try again.');
      return;
    }
    await submitWrite(
      `submit_corpus("${title.slice(0, 28)}")`,
      'submit_corpus',
      [title, rule, profile, entriesJson, 3600n, 300n, 3600n],
      BigInt(bondWei || '20')
    );
  }

  async function handleCommitAudit() {
    const commitHash = await sha256HexBrowser(saltInput);
    setSavedSalts((prev) => ({ ...prev, [`corpus_${targetCorpusId}`]: saltInput }));
    await submitWrite(
      `commit_audit(corpus ${targetCorpusId})`,
      'commit_audit',
      [BigInt(targetCorpusId), commitHash],
      BigInt(stakeWei || '25')
    );
  }

  return (
    <div className="instrument-sheet">
      <div className="sheet-band">
        <div className="workbench-bar">
          <div>
            <h2 className="section-heading">StudioNet wallet workbench</h2>
            <p className="section-desc">
              Execute live writes on Chain 61999. Transactions persist in local storage and poll every 8 seconds across reloads until finality.
            </p>
          </div>
          <div className="action-row">
            {account ? (
              <>
                <span className="code-hex" style={{ fontWeight: 600 }}>
                  {shortHex(account, 6, 4)}
                </span>
                <button type="button" className="btn-secondary" onClick={refreshAccount}>
                  <RefreshCw size={14} /> Refresh balances
                </button>
              </>
            ) : (
              <button type="button" className="btn-primary" onClick={handleConnect}>
                <Wallet size={15} /> Connect MetaMask (Chain 61999)
              </button>
            )}
          </div>
        </div>

        {account && (
          <div className="balance-inline tabular">
            <div className="balance-pair">
              <span className="kv-label">Claimable winnings:</span>
              <strong className="outcome-text certify">{balances.claimable_wei} wei</strong>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy || balances.claimable_wei === 0}
                onClick={() => submitWrite('claim_winnings()', 'claim_winnings', [])}
              >
                Claim
              </button>
            </div>
            <div className="balance-pair">
              <span className="kv-label">Refundable balance:</span>
              <strong className="outcome-text pending">{balances.refundable_wei} wei</strong>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy || balances.refundable_wei === 0}
                onClick={() => submitWrite('withdraw_refund()', 'withdraw_refund', [])}
              >
                Withdraw refund
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="sheet-band">
        <div className="band-header">
          <div className="segmented light" role="tablist" aria-label="Wallet action workflow">
            <button
              type="button"
              role="tab"
              aria-selected={actionMode === 'publish'}
              className={actionMode === 'publish' ? 'active' : ''}
              onClick={() => setActionMode('publish')}
            >
              Publish corpus
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={actionMode === 'audit'}
              className={actionMode === 'audit' ? 'active' : ''}
              onClick={() => setActionMode('audit')}
            >
              Challenge and sample ({openCorpora.length} open)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={actionMode === 'fallback'}
              className={actionMode === 'fallback' ? 'active' : ''}
              onClick={() => setActionMode('fallback')}
            >
              Timeout fallbacks
            </button>
          </div>
        </div>

        {errorMsg && (
          <div className="error-inline" style={{ marginBottom: 14 }}>
            <AlertCircle size={15} /> {errorMsg}
          </div>
        )}

        {actionMode === 'publish' && (
          <form className="wb-form" onSubmit={handlePublishCorpus}>
            <div className="form-grid-3">
              <label className="field">
                <span>Corpus title</span>
                <input value={title} onChange={(e) => setTitle(e.target.value)} required />
              </label>
              <label className="field">
                <span>SPRT profile</span>
                <select value={profile} onChange={(e) => setProfile(e.target.value as any)}>
                  <option value="STANDARD_90">STANDARD_90 (4 pass / 2 fail)</option>
                  <option value="HIGH_ASSURANCE_95">HIGH_ASSURANCE_95 (6 pass / 2 fail)</option>
                  <option value="STRICT_95">STRICT_95 (8 pass / 2 fail)</option>
                </select>
              </label>
              <label className="field">
                <span>Veracity bond (wei, minimum 2)</span>
                <input type="number" min={2} value={bondWei} onChange={(e) => setBondWei(e.target.value)} required />
              </label>
            </div>
            <label className="field">
              <span>Grounding rule (vetted up front by GenLayer RuleGate)</span>
              <input value={rule} onChange={(e) => setRule(e.target.value)} required />
            </label>
            <label className="field">
              <span>Immutable citation manifest JSON</span>
              <textarea rows={7} value={entriesJson} onChange={(e) => setEntriesJson(e.target.value)} />
            </label>
            <div className="action-row">
              <button type="submit" className="btn-primary" disabled={busy || !account}>
                <Send size={14} /> Submit corpus and run RuleGate
              </button>
            </div>
          </form>
        )}

        {actionMode === 'audit' && (
          <div className="wb-form">
            <div className="form-grid-3">
              <label className="field">
                <span>Open corpus ID</span>
                <input type="number" min={1} value={targetCorpusId} onChange={(e) => setTargetCorpusId(e.target.value)} />
              </label>
              <label className="field">
                <span>Auditor stake (wei)</span>
                <input type="number" min={1} value={stakeWei} onChange={(e) => setStakeWei(e.target.value)} />
              </label>
              <label className="field">
                <span>Commit-reveal salt (auto-saved locally)</span>
                <input className="code-hex" value={saltInput} onChange={(e) => setSaltInput(e.target.value)} />
              </label>
            </div>
            <div className="action-row">
              <button type="button" className="btn-primary" disabled={busy || !account} onClick={handleCommitAudit}>
                Commit seed hash and stake
              </button>
            </div>

            <div className="form-grid-2" style={{ paddingTop: 14, borderTop: '1px solid var(--border)' }}>
              <label className="field">
                <span>Audit ID to reveal or sample</span>
                <input type="number" min={1} value={targetAuditId} onChange={(e) => setTargetAuditId(e.target.value)} />
              </label>
              <div className="action-row" style={{ alignItems: 'flex-end' }}>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy || !account}
                  onClick={() =>
                    submitWrite(`reveal_audit_seed(audit ${targetAuditId})`, 'reveal_audit_seed', [
                      BigInt(targetAuditId),
                      saltInput,
                    ])
                  }
                >
                  Reveal salt
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy || !account}
                  onClick={() =>
                    submitWrite(`step_audit_sample(audit ${targetAuditId})`, 'step_audit_sample', [
                      BigInt(targetAuditId),
                    ])
                  }
                >
                  Step next SPRT sample
                </button>
              </div>
            </div>
          </div>
        )}

        {actionMode === 'fallback' && (
          <div className="wb-form">
            <p className="section-desc">
              Every waiting state exposes a permissionless deadline fallback so escrowed GEN can never lock indefinitely.
            </p>
            <div className="form-grid-2">
              <label className="field">
                <span>Corpus ID</span>
                <input type="number" min={1} value={targetCorpusId} onChange={(e) => setTargetCorpusId(e.target.value)} />
              </label>
              <label className="field">
                <span>Audit ID</span>
                <input type="number" min={1} value={targetAuditId} onChange={(e) => setTargetAuditId(e.target.value)} />
              </label>
            </div>
            <div className="action-row">
              <button
                type="button"
                className="btn-secondary"
                disabled={busy || !account}
                onClick={() =>
                  submitWrite(`reclaim_stalled_vetting(${targetCorpusId})`, 'reclaim_stalled_vetting', [
                    BigInt(targetCorpusId),
                  ])
                }
              >
                Reclaim stalled vetting
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy || !account}
                onClick={() =>
                  submitWrite(`close_unchallenged_corpus(${targetCorpusId})`, 'close_unchallenged_corpus', [
                    BigInt(targetCorpusId),
                  ])
                }
              >
                Close unchallenged corpus
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy || !account}
                onClick={() =>
                  submitWrite(`expire_unrevealed_audit(${targetAuditId})`, 'expire_unrevealed_audit', [
                    BigInt(targetAuditId),
                  ])
                }
              >
                Expire unrevealed audit
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy || !account}
                onClick={() =>
                  submitWrite(`expire_stalled_audit(${targetAuditId})`, 'expire_stalled_audit', [
                    BigInt(targetAuditId),
                  ])
                }
              >
                Expire stalled audit
              </button>
            </div>
          </div>
        )}
      </div>

      {trackedTxs.length > 0 && (
        <div className="sheet-band">
          <div className="band-header" style={{ marginBottom: 8 }}>
            <h2 className="section-heading">Submitted transaction monitor</h2>
            <button type="button" className="btn-secondary" onClick={() => setTrackedTxs([])}>
              Clear list
            </button>
          </div>
          <div className="tx-list">
            {trackedTxs.map((t) => (
              <div key={t.hash} className="tx-list-row">
                <div className="tx-list-left">
                  <span
                    className={`table-status ${
                      t.phase === 'finalized-success'
                        ? 'ok'
                        : t.phase === 'finalized-error'
                        ? 'err'
                        : 'wait'
                    }`}
                  >
                    {t.phase}
                  </span>
                  <span className="code-hex">{t.label}</span>
                  {t.phase === 'accepted' && (
                    <span className="kv-label">Appeal window open (waiting for finality callback)</span>
                  )}
                  {t.errorDetail && <span className="outcome-text reject">{t.errorDetail}</span>}
                </div>
                <a
                  href={`${STUDIONET_EXPLORER}/transactions/${t.hash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="code-hex"
                >
                  {shortHex(t.hash, 6, 4)} <ExternalLink size={12} />
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
