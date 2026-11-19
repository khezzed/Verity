export interface CorpusEntry {
  claim: string;
  source_url: string;
  anchor: string;
}

export interface CorpusRecord {
  corpus_id: number;
  publisher: string;
  domain_title: string;
  grounding_rule: string;
  profile_id: string;
  entries: CorpusEntry[];
  entry_count: number;
  manifest_sha256: string;
  bond_wei: number;
  min_audit_stake_wei: number;
  status: string;
  vetting_reason: string;
  created_at: number;
  vetting_deadline: number;
  challenge_duration_sec: number;
  reveal_window_sec: number;
  audit_duration_sec: number;
  challenge_deadline: number;
  active_audit_id: number;
  audit_ids: number[];
}

export interface SampleRecord {
  seq: number;
  entry_idx: number;
  fetch_status: string;
  slice_sha256: string;
  verdict: string;
  verbatim_quote: string;
  llr_delta: number;
  llr_after: number;
  finalized_at: number;
}

export interface AuditRecord {
  audit_id: number;
  corpus_id: number;
  auditor: string;
  stake_wei: number;
  salt_commit_hash: string;
  salt_preimage: string;
  seed_hex: string;
  commit_ts: number;
  reveal_deadline: number;
  audit_deadline: number;
  grace_deadline: number;
  status: string;
  profile_id: string;
  llr_scaled: number;
  bound_certify: number;
  bound_reject: number;
  delta_pass: number;
  delta_fail: number;
  sample_order: number[];
  next_cursor: number;
  samples_counted: number;
  in_flight_seq: number;
  in_flight_entry_idx: number;
  in_flight_retries: number;
  samples: SampleRecord[];
  terminal_decision: string;
  settled_at: number;
}

export interface ProtocolInfo {
  judge_address: string;
  corpus_count: number;
  audit_count: number;
  total_inbound_wei: number;
  total_outbound_wei: number;
  total_publisher_bonds: number;
  total_auditor_stakes: number;
  total_claimable: number;
  total_refundable: number;
  contract_balance_wei: number;
  conservation_ok: boolean;
  sprt_scale: number;
  profiles: Record<
    string,
    {
      p0_bps: number;
      p1_bps: number;
      alpha_bps: number;
      beta_bps: number;
      delta_pass: number;
      delta_fail: number;
      bound_certify: number;
      bound_reject: number;
      min_entries: number;
    }
  >;
}

export interface JudgeInfo {
  owner: string;
  vault_address: string;
  vault_bound: boolean;
  vettings_completed: number;
  samples_judged: number;
}

export interface EmittedChildTx {
  txHash: string;
  statusName: string;
  resultName: string;
  executionResult: string;
  returnReadable: unknown;
  explorerUrl: string;
}

export interface RecordedTx {
  step: string;
  caseId: string;
  actor: string;
  contract: string;
  method: string;
  txHash: string;
  statusName: string;
  resultName: string;
  executionResult: string;
  returnReadable: unknown;
  explorerUrl: string;
  emittedChildren: EmittedChildTx[];
}

export interface ProofManifest {
  project: string;
  tagline: string;
  generatedAt: string;
  sourceCommit: string;
  network: {
    name: string;
    chainId: number;
    rpcUrl: string;
    explorerUrl: string;
    pinnedRunner: string;
  };
  actors: {
    deployer: string;
    publisher: string;
    auditor: string;
  };
  contracts: {
    evidenceProbe: {
      address: string;
      deployTx: string;
      sourcePath: string;
      sourceSha256: string;
      blobSha1: string;
      explorerUrl: string;
    } | null;
    verityCitationJudge: {
      address: string;
      deployTx: string;
      sourcePath: string;
      sourceSha256: string;
      blobSha1: string;
      explorerUrl: string;
    };
    verityAuditVault: {
      address: string;
      deployTx: string;
      sourcePath: string;
      sourceSha256: string;
      blobSha1: string;
      explorerUrl: string;
    };
  };
  onChainState: {
    protocolInfo: ProtocolInfo;
    judgeInfo: JudgeInfo;
    corpora: CorpusRecord[];
    audits: AuditRecord[];
  };
  transactions: RecordedTx[];
}

export type TrackedTxPhase =
  | 'submitted'
  | 'pending'
  | 'accepted'
  | 'finalized-success'
  | 'finalized-error';

export interface TrackedTx {
  hash: string;
  label: string;
  phase: TrackedTxPhase;
  consensusResult?: string;
  childHashes?: string[];
  submittedAt: number;
  updatedAt: number;
  errorDetail?: string;
}
