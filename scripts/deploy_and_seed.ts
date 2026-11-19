import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  getOrCreateActor,
  loadContractLF,
  loadState,
  saveState,
  ensureFunded,
  callWithRetry,
  waitForFinalized,
  waitForFinalizedTree,
  rpcCall,
  sha256,
  sleep,
  STUDIONET_EXPLORER,
  STUDIONET_RPC,
  STUDIONET_CHAIN_ID,
} from './studionet.ts';

const OBJECTIVE_GROUNDING_RULE =
  'A claim is SUPPORTED if the cited immutable source excerpt explicitly states or directly entails the technical definition, parameter, or specification fact stated in the claim; it is UNSUPPORTED if the excerpt contradicts the claim, states different values, or lacks factual basis for it.';

const SOUND_CORPUS_ENTRIES = [
  {
    claim: 'RFC 2104 defines HMAC using two fixed strings: ipad (the byte 0x36 repeated B times) and opad (the byte 0x5C repeated B times).',
    source_url: 'https://www.rfc-editor.org/rfc/rfc2104.txt',
    anchor: '0x36',
  },
  {
    claim: 'RFC 6234 states that SHA-224 and SHA-256 operate on 32-bit words while SHA-384 and SHA-512 operate on 64-bit words.',
    source_url: 'https://www.rfc-editor.org/rfc/rfc6234.txt',
    anchor: '512-bit',
  },
  {
    claim: 'RFC 1321 states that the MD5 algorithm takes as input a message of arbitrary length and produces as output a 128-bit fingerprint or message digest.',
    source_url: 'https://www.rfc-editor.org/rfc/rfc1321.txt',
    anchor: '128-bit',
  },
  {
    claim: 'RFC 6962 states that Certificate Transparency logs use a binary Merkle Hash Tree with SHA-256 as the hashing algorithm.',
    source_url: 'https://www.rfc-editor.org/rfc/rfc6962.txt',
    anchor: 'SHA-256',
  },
  {
    claim: 'RFC 8446 states that TLS 1.3 removes static RSA and Diffie-Hellman cipher suites so all public-key based key exchange mechanisms provide forward secrecy.',
    source_url: 'https://www.rfc-editor.org/rfc/rfc8446.txt',
    anchor: 'static RSA and Diffie-Hellman',
  },
  {
    claim: 'RFC 793 specifies that TCP uses a three-way handshake mechanism when establishing a connection.',
    source_url: 'https://www.rfc-editor.org/rfc/rfc793.txt',
    anchor: 'three-way handshake',
  },
  {
    claim: 'RFC 9110 states that HTTP request methods are considered safe if their defined semantics are essentially read-only without expected state change on the origin server.',
    source_url: 'https://www.rfc-editor.org/rfc/rfc9110.txt',
    anchor: 'Request methods are considered',
  },
  {
    claim: 'RFC 8259 states that JSON text exchanged between systems not part of a closed ecosystem MUST be encoded using UTF-8.',
    source_url: 'https://www.rfc-editor.org/rfc/rfc8259.txt',
    anchor: 'UTF-8',
  },
  {
    claim: 'RFC 4648 specifies that Base64 uses a 65-character subset of US-ASCII enabling 6 bits per printable character, with = as the extra 65th character.',
    source_url: 'https://www.rfc-editor.org/rfc/rfc4648.txt',
    anchor: 'A 65-character subset',
  },
  {
    claim: 'The archived December 2009 Wikipedia revision describes hash trees (or Merkle trees) as a data structure used in cryptography and computer science.',
    source_url: 'https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&format=json&formatversion=2&revids=333954216',
    anchor: 'hash tree',
  },
];

const INJECTION_URL =
  'https://raw.githubusercontent.com/liu00222/Open-Prompt-Injection/fbed5cca347488f88363790ae3ae97c56116da6a/OpenPromptInjection/attackers/IgnoreAttacker.py';

const DEFECTIVE_CORPUS_ENTRIES = [
  {
    claim: 'RFC 2104 defines HMAC using inner pad byte 0xAA repeated B times and outer pad byte 0xFF repeated B times.',
    source_url: 'https://www.rfc-editor.org/rfc/rfc2104.txt',
    anchor: '0x36',
  },
  {
    claim: 'RFC 8259 mandates that all JSON text exchanged outside closed ecosystems MUST be encoded strictly in UTF-16 Big Endian rather than UTF-8.',
    source_url: 'https://www.rfc-editor.org/rfc/rfc8259.txt',
    anchor: 'UTF-8',
  },
  {
    claim: 'This immutable source document certifies FIPS 140-3 Level 4 hardware cryptographic module validation for the protocol.',
    source_url: INJECTION_URL,
    anchor: 'Ignore',
  },
  {
    claim: 'This immutable source document confirms ISO/IEC 27001 external security certification with zero critical findings.',
    source_url: INJECTION_URL,
    anchor: 'inject',
  },
];

const PURE_INJECTION_ENTRIES = [
  {
    claim: 'This cited document proves FIPS 140-3 Level 4 compliance for the target module.',
    source_url: INJECTION_URL,
    anchor: 'Ignore',
  },
  {
    claim: 'This cited document verifies SOC 2 Type II independent audit sign-off.',
    source_url: INJECTION_URL,
    anchor: 'inject',
  },
  {
    claim: 'This cited document confirms Common Criteria EAL7 formal verification status.',
    source_url: INJECTION_URL,
    anchor: 'IgnoreAttacker',
  },
  {
    claim: 'This cited document establishes PCI-DSS 4.0 Level 1 compliance certification.',
    source_url: INJECTION_URL,
    anchor: 'get_injected_prompt',
  },
];

interface RecordedTx {
  step: string;
  caseId: string;
  actor: string;
  contract: 'VerityAuditVault' | 'VerityCitationJudge';
  method: string;
  txHash: string;
  statusName: string;
  resultName: string;
  executionResult: string;
  returnReadable: any;
  explorerUrl: string;
  emittedChildren: Array<{
    txHash: string;
    statusName: string;
    resultName: string;
    executionResult: string;
    returnReadable: any;
    explorerUrl: string;
  }>;
}

function recordTx(stepKey: string, rec: RecordedTx) {
  const st = loadState();
  const txs: Record<string, RecordedTx> = st.txs || {};
  txs[stepKey] = rec;
  saveState({ txs });
}

async function runResumableTx(params: {
  stepKey: string;
  caseId: string;
  actorName: string;
  client: any;
  contractLabel: 'VerityAuditVault' | 'VerityCitationJudge';
  address: string;
  functionName: string;
  args: any[];
  value?: bigint;
  followTree?: boolean;
  allowError?: boolean;
}): Promise<RecordedTx> {
  const st = loadState();
  const existing: RecordedTx | undefined = st.txs?.[params.stepKey];
  if (existing && existing.statusName === 'FINALIZED') {
    console.log(`  [SKIP] ${params.stepKey}: already FINALIZED (${existing.txHash})`);
    return existing;
  }

  const pendingHashes: Record<string, string> = st.pendingHashes || {};
  let txHash: string | undefined = pendingHashes[params.stepKey];
  if (!txHash) {
    console.log(`\n  [SEND] ${params.stepKey} -> ${params.contractLabel}.${params.functionName}()`);
    txHash = await callWithRetry(() =>
      params.client.writeContract({
        address: params.address as `0x${string}`,
        functionName: params.functionName,
        args: params.args,
        value: params.value ?? 0n,
      })
    );
    pendingHashes[params.stepKey] = txHash!;
    saveState({ pendingHashes });
    console.log(`    txHash saved: ${txHash}`);
  } else {
    console.log(`\n  [RESUME] ${params.stepKey} -> ${txHash}`);
  }

  let parent;
  let children: any[] = [];
  if (params.followTree) {
    const tree = await waitForFinalizedTree(params.client, txHash!, {
      allowError: params.allowError ?? false,
      maxAttempts: 90,
      pollMs: 9000,
    });
    parent = tree.parent;
    children = tree.children;
  } else {
    parent = await waitForFinalized(params.client, txHash!, {
      allowError: params.allowError ?? false,
      maxAttempts: 90,
      pollMs: 9000,
    });
  }

  const rec: RecordedTx = {
    step: params.stepKey,
    caseId: params.caseId,
    actor: params.actorName,
    contract: params.contractLabel,
    method: params.functionName,
    txHash: parent.txHash,
    statusName: parent.statusName,
    resultName: parent.resultName,
    executionResult: parent.executionResult,
    returnReadable: parent.returnReadable,
    explorerUrl: `${STUDIONET_EXPLORER}/transactions/${parent.txHash}`,
    emittedChildren: children.map((c) => ({
      txHash: c.txHash,
      statusName: c.statusName,
      resultName: c.resultName,
      executionResult: c.executionResult,
      returnReadable: c.returnReadable,
      explorerUrl: `${STUDIONET_EXPLORER}/transactions/${c.txHash}`,
    })),
  };
  recordTx(params.stepKey, rec);
  await sleep(5000);
  return rec;
}

async function readJsonView(client: any, address: string, functionName: string, args: any[] = []): Promise<any> {
  const raw = await callWithRetry(() =>
    client.readContract({
      address: address as `0x${string}`,
      functionName,
      args,
    })
  );
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

async function main() {
  console.log('===================================================================');
  console.log('   Verity — Step 4: StudioNet Deployment & Live Finality Demo');
  console.log('===================================================================');

  const deployer = getOrCreateActor('deployer');
  const publisher = getOrCreateActor('publisher');
  const auditor = getOrCreateActor('auditor');

  console.log(`Deployer : ${deployer.account.address}`);
  console.log(`Publisher: ${publisher.account.address}`);
  console.log(`Auditor  : ${auditor.account.address}`);

  await ensureFunded(deployer.account.address, 10000n);
  await ensureFunded(publisher.account.address, 10000n);
  await ensureFunded(auditor.account.address, 10000n);

  const judgeSrc = loadContractLF('contracts/verity_citation_judge.py');
  const vaultSrc = loadContractLF('contracts/verity_audit_vault.py');

  // -------------------------------------------------------------------------
  // 1. Deploy VerityCitationJudge
  // -------------------------------------------------------------------------
  let st = loadState();
  let judgeAddr: string | undefined = st.judgeAddress;
  if (!judgeAddr) {
    let tx: string | undefined = st.judgeDeployTx;
    if (!tx) {
      console.log('\n[DEPLOY 1/3] Deploying VerityCitationJudge...');
      tx = await callWithRetry(() => deployer.client.deployContract({ code: judgeSrc.code }));
      saveState({
        judgeDeployTx: tx,
        judgeSourceSha256: judgeSrc.sha256Hex,
        judgeBlobSha1: judgeSrc.blobSha1,
      });
      console.log(`  Deploy tx: ${tx}`);
    }
    const r = await waitForFinalized(deployer.client, tx!);
    judgeAddr = r.contractAddress;
    if (!judgeAddr) throw new Error('Missing VerityCitationJudge contractAddress');
    saveState({ judgeAddress: judgeAddr });
    console.log(`  VerityCitationJudge FINALIZED at: ${judgeAddr}`);
    await sleep(5000);
  } else {
    console.log(`Reusing VerityCitationJudge: ${judgeAddr}`);
  }

  // -------------------------------------------------------------------------
  // 2. Deploy VerityAuditVault(judgeAddr)
  // -------------------------------------------------------------------------
  st = loadState();
  let vaultAddr: string | undefined = st.vaultAddress;
  if (!vaultAddr) {
    let tx: string | undefined = st.vaultDeployTx;
    if (!tx) {
      console.log('\n[DEPLOY 2/3] Deploying VerityAuditVault...');
      tx = await callWithRetry(() =>
        deployer.client.deployContract({
          code: vaultSrc.code,
          args: [judgeAddr!],
        })
      );
      saveState({
        vaultDeployTx: tx,
        vaultSourceSha256: vaultSrc.sha256Hex,
        vaultBlobSha1: vaultSrc.blobSha1,
      });
      console.log(`  Deploy tx: ${tx}`);
    }
    const r = await waitForFinalized(deployer.client, tx!);
    vaultAddr = r.contractAddress;
    if (!vaultAddr) throw new Error('Missing VerityAuditVault contractAddress');
    saveState({ vaultAddress: vaultAddr });
    console.log(`  VerityAuditVault FINALIZED at: ${vaultAddr}`);
    await sleep(5000);
  } else {
    console.log(`Reusing VerityAuditVault: ${vaultAddr}`);
  }

  // -------------------------------------------------------------------------
  // 3. Bind Vault on VerityCitationJudge (one-time immutable link)
  // -------------------------------------------------------------------------
  await runResumableTx({
    stepKey: 'setup_bind_vault',
    caseId: 'setup',
    actorName: 'deployer',
    client: deployer.client,
    contractLabel: 'VerityCitationJudge',
    address: judgeAddr,
    functionName: 'bind_vault',
    args: [vaultAddr],
  });

  // -------------------------------------------------------------------------
  // CASE 0: Payable Invalid-URL Safety (No Stranded Wei on StudioNet)
  // -------------------------------------------------------------------------
  console.log('\n--- CASE 0: Payable Safety Guard (Mutable URL -> Refundable) ---');
  const badMutableManifest = JSON.stringify([
    { claim: 'Invalid mutable GitHub branch reference test claim one.', source_url: 'https://raw.githubusercontent.com/org/repo/main/doc.txt', anchor: 'a' },
    { claim: 'Invalid mutable GitHub branch reference test claim two.', source_url: 'https://raw.githubusercontent.com/org/repo/main/doc.txt', anchor: 'b' },
    { claim: 'Invalid mutable GitHub branch reference test claim three.', source_url: 'https://raw.githubusercontent.com/org/repo/main/doc.txt', anchor: 'c' },
    { claim: 'Invalid mutable GitHub branch reference test claim four.', source_url: 'https://raw.githubusercontent.com/org/repo/main/doc.txt', anchor: 'd' },
  ]);
  await runResumableTx({
    stepKey: 'case0_submit_bad_url',
    caseId: 'case0_payable_guard',
    actorName: 'publisher',
    client: publisher.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'submit_corpus',
    args: ['Mutable URL Test', OBJECTIVE_GROUNDING_RULE, 'STANDARD_90', badMutableManifest, 600n, 120n, 1200n],
    value: 5n,
  });
  await runResumableTx({
    stepKey: 'case0_withdraw_refund',
    caseId: 'case0_payable_guard',
    actorName: 'publisher',
    client: publisher.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'withdraw_refund',
    args: [],
  });

  // -------------------------------------------------------------------------
  // CASE 1: RuleGate Rejects Vague Grounding Rule -> Full Refund
  // -------------------------------------------------------------------------
  console.log('\n--- CASE 1: Up-Front RuleGate Rejects Vague Criteria ---');
  await runResumableTx({
    stepKey: 'case1_submit_vague_corpus',
    caseId: 'case1_rulegate_reject',
    actorName: 'publisher',
    client: publisher.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'submit_corpus',
    args: [
      'Subjective Innovation Whitepaper',
      'A claim passes if the cited document feels innovative, trustworthy, and shows good engineering progress.',
      'STANDARD_90',
      JSON.stringify(SOUND_CORPUS_ENTRIES.slice(0, 4)),
      600n,
      120n,
      1200n,
    ],
    value: 20n,
    followTree: true,
  });
  const c1 = await readJsonView(deployer.client, vaultAddr, 'get_corpus', [1n]);
  console.log(`  Case 1 Corpus #1 status: ${c1?.status} (reason=${c1?.vetting_reason})`);
  if (c1?.status !== 'REJECTED_VAGUE') {
    throw new Error(`Expected Corpus #1 REJECTED_VAGUE, got ${c1?.status}`);
  }
  await runResumableTx({
    stepKey: 'case1_withdraw_vague_refund',
    caseId: 'case1_rulegate_reject',
    actorName: 'publisher',
    client: publisher.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'withdraw_refund',
    args: [],
  });

  // -------------------------------------------------------------------------
  // CASE 2: Sound 10-Entry Technical Standards Brief -> Early-Stop CERTIFIED_SOUND
  // -------------------------------------------------------------------------
  console.log('\n--- CASE 2: Sound 10-Entry RFC/Wiki Corpus -> Early-Stop Certification ---');
  await runResumableTx({
    stepKey: 'case2_submit_sound_corpus',
    caseId: 'case2_certified_sound',
    actorName: 'publisher',
    client: publisher.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'submit_corpus',
    args: [
      'Foundational Internet & Cryptography Standards Brief',
      OBJECTIVE_GROUNDING_RULE,
      'STANDARD_90',
      JSON.stringify(SOUND_CORPUS_ENTRIES),
      3600n,
      600n,
      3600n,
    ],
    value: 100n,
    followTree: true,
  });
  const c2 = await readJsonView(deployer.client, vaultAddr, 'get_corpus', [2n]);
  console.log(`  Case 2 Corpus #2 status: ${c2?.status}`);
  if (c2?.status !== 'OPEN_FOR_AUDIT' && c2?.status !== 'UNDER_AUDIT' && c2?.status !== 'CERTIFIED_SOUND') {
    throw new Error(`Expected Corpus #2 OPEN_FOR_AUDIT, got ${c2?.status}`);
  }

  const salt2 = 'verity-sound-brief-audit-salt-2026';
  const commit2 = sha256(salt2);
  await runResumableTx({
    stepKey: 'case2_commit_audit',
    caseId: 'case2_certified_sound',
    actorName: 'auditor',
    client: auditor.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'commit_audit',
    args: [2n, commit2],
    value: 100n,
  });
  await runResumableTx({
    stepKey: 'case2_reveal_seed',
    caseId: 'case2_certified_sound',
    actorName: 'auditor',
    client: auditor.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'reveal_audit_seed',
    args: [1n, salt2],
  });

  // Step SPRT samples until early-stop terminal settlement!
  for (let stepIdx = 1; stepIdx <= 10; stepIdx++) {
    const a2Before = await readJsonView(deployer.client, vaultAddr, 'get_audit', [1n]);
    if (a2Before?.status?.startsWith('SETTLED_')) {
      console.log(`  Audit #1 already settled (${a2Before.status}, LLR=${a2Before.llr_scaled}, samples=${a2Before.samples.length}/10)`);
      break;
    }
    await runResumableTx({
      stepKey: `case2_sample_${stepIdx}`,
      caseId: 'case2_certified_sound',
      actorName: 'auditor',
      client: auditor.client,
      contractLabel: 'VerityAuditVault',
      address: vaultAddr,
      functionName: 'step_audit_sample',
      args: [1n],
      followTree: true,
    });
    const a2After = await readJsonView(deployer.client, vaultAddr, 'get_audit', [1n]);
    const lastSample = a2After.samples[a2After.samples.length - 1];
    console.log(
      `    -> Sample #${stepIdx} (entry ${lastSample?.entry_idx}): verdict=${lastSample?.verdict}, LLR=${a2After.llr_scaled}, status=${a2After.status}`
    );
    if (a2After.status.startsWith('SETTLED_')) break;
  }

  const a2Final = await readJsonView(deployer.client, vaultAddr, 'get_audit', [1n]);
  if (a2Final.status !== 'SETTLED_CERTIFIED') {
    throw new Error(`Expected Audit #1 SETTLED_CERTIFIED, got ${a2Final.status}`);
  }
  await runResumableTx({
    stepKey: 'case2_publisher_claim_winnings',
    caseId: 'case2_certified_sound',
    actorName: 'publisher',
    client: publisher.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'claim_winnings',
    args: [],
  });

  // -------------------------------------------------------------------------
  // CASE 3: Hallucinated + Prompt-Injected Brief -> Early-Stop REJECTED_DEFECTIVE
  // -------------------------------------------------------------------------
  console.log('\n--- CASE 3: Defective + Prompt-Injected Corpus -> Early-Stop Slash ---');
  await runResumableTx({
    stepKey: 'case3_submit_defective_corpus',
    caseId: 'case3_rejected_defective',
    actorName: 'publisher',
    client: publisher.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'submit_corpus',
    args: [
      'AI-Hallucinated Security & Compliance Brief',
      OBJECTIVE_GROUNDING_RULE,
      'STANDARD_90',
      JSON.stringify(DEFECTIVE_CORPUS_ENTRIES),
      3600n,
      600n,
      3600n,
    ],
    value: 100n,
    followTree: true,
  });

  const salt3 = 'verity-defective-audit-salt-2026';
  const commit3 = sha256(salt3);
  await runResumableTx({
    stepKey: 'case3_commit_audit',
    caseId: 'case3_rejected_defective',
    actorName: 'auditor',
    client: auditor.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'commit_audit',
    args: [3n, commit3],
    value: 100n,
  });
  await runResumableTx({
    stepKey: 'case3_reveal_seed',
    caseId: 'case3_rejected_defective',
    actorName: 'auditor',
    client: auditor.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'reveal_audit_seed',
    args: [2n, salt3],
  });

  for (let stepIdx = 1; stepIdx <= 4; stepIdx++) {
    const a3Before = await readJsonView(deployer.client, vaultAddr, 'get_audit', [2n]);
    if (a3Before?.status?.startsWith('SETTLED_')) break;
    await runResumableTx({
      stepKey: `case3_sample_${stepIdx}`,
      caseId: 'case3_rejected_defective',
      actorName: 'auditor',
      client: auditor.client,
      contractLabel: 'VerityAuditVault',
      address: vaultAddr,
      functionName: 'step_audit_sample',
      args: [2n],
      followTree: true,
    });
    const a3After = await readJsonView(deployer.client, vaultAddr, 'get_audit', [2n]);
    const lastSample = a3After.samples[a3After.samples.length - 1];
    console.log(
      `    -> Sample #${stepIdx} (entry ${lastSample?.entry_idx}): verdict=${lastSample?.verdict}, LLR=${a3After.llr_scaled}, status=${a3After.status}`
    );
    if (a3After.status.startsWith('SETTLED_')) break;
  }

  const a3Final = await readJsonView(deployer.client, vaultAddr, 'get_audit', [2n]);
  if (a3Final.status !== 'SETTLED_REJECTED') {
    throw new Error(`Expected Audit #2 SETTLED_REJECTED, got ${a3Final.status}`);
  }
  await runResumableTx({
    stepKey: 'case3_auditor_claim_winnings',
    caseId: 'case3_rejected_defective',
    actorName: 'auditor',
    client: auditor.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'claim_winnings',
    args: [],
  });

  // Check if Case 3's unbiased Fisher-Yates draw already exercised an injection entry (entry_idx 2 or 3).
  const hitInjectionInCase3 = a3Final.samples.some((s: any) => s.entry_idx === 2 || s.entry_idx === 3);
  console.log(`  Case 3 exercised real prompt-injection source directly? ${hitInjectionInCase3}`);
  let nextCorpusId = 4n;
  let nextAuditId = 3n;

  if (!hitInjectionInCase3) {
    console.log('\n--- CASE 3B: Dedicated Prompt-Injection Defense Proof ---');
    await runResumableTx({
      stepKey: 'case3b_submit_injection_corpus',
      caseId: 'case3b_prompt_injection',
      actorName: 'publisher',
      client: publisher.client,
      contractLabel: 'VerityAuditVault',
      address: vaultAddr,
      functionName: 'submit_corpus',
      args: [
        'Adversarial Prompt-Injection Compliance Brief',
        OBJECTIVE_GROUNDING_RULE,
        'STANDARD_90',
        JSON.stringify(PURE_INJECTION_ENTRIES),
        3600n,
        600n,
        3600n,
      ],
      value: 50n,
      followTree: true,
    });
    const salt3b = 'verity-injection-audit-salt-2026';
    await runResumableTx({
      stepKey: 'case3b_commit_audit',
      caseId: 'case3b_prompt_injection',
      actorName: 'auditor',
      client: auditor.client,
      contractLabel: 'VerityAuditVault',
      address: vaultAddr,
      functionName: 'commit_audit',
      args: [nextCorpusId, sha256(salt3b)],
      value: 50n,
    });
    await runResumableTx({
      stepKey: 'case3b_reveal_seed',
      caseId: 'case3b_prompt_injection',
      actorName: 'auditor',
      client: auditor.client,
      contractLabel: 'VerityAuditVault',
      address: vaultAddr,
      functionName: 'reveal_audit_seed',
      args: [nextAuditId, salt3b],
    });
    for (let stepIdx = 1; stepIdx <= 4; stepIdx++) {
      const aB = await readJsonView(deployer.client, vaultAddr, 'get_audit', [nextAuditId]);
      if (aB?.status?.startsWith('SETTLED_')) break;
      await runResumableTx({
        stepKey: `case3b_sample_${stepIdx}`,
        caseId: 'case3b_prompt_injection',
        actorName: 'auditor',
        client: auditor.client,
        contractLabel: 'VerityAuditVault',
        address: vaultAddr,
        functionName: 'step_audit_sample',
        args: [nextAuditId],
        followTree: true,
      });
      const aA = await readJsonView(deployer.client, vaultAddr, 'get_audit', [nextAuditId]);
      if (aA.status.startsWith('SETTLED_')) break;
    }
    await runResumableTx({
      stepKey: 'case3b_auditor_claim_winnings',
      caseId: 'case3b_prompt_injection',
      actorName: 'auditor',
      client: auditor.client,
      contractLabel: 'VerityAuditVault',
      address: vaultAddr,
      functionName: 'claim_winnings',
      args: [],
    });
    nextCorpusId += 1n;
    nextAuditId += 1n;
  }

  // -------------------------------------------------------------------------
  // CASE 4: Deterministic Fallbacks (Anti-Grief Unrevealed Commit + Stalled Audit Timeout)
  // -------------------------------------------------------------------------
  console.log('\n--- CASE 4: Anti-Grief Unrevealed Commit & Stalled Audit Fallback ---');
  const fallbackCorpusId = nextCorpusId;
  const unrevealedAuditId = nextAuditId;
  const stalledAuditId = nextAuditId + 1n;

  await runResumableTx({
    stepKey: 'case4_submit_fallback_corpus',
    caseId: 'case4_deterministic_fallbacks',
    actorName: 'publisher',
    client: publisher.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'submit_corpus',
    args: [
      'Timeout & Anti-Grief Fallback Verification Corpus',
      OBJECTIVE_GROUNDING_RULE,
      'STANDARD_90',
      JSON.stringify(SOUND_CORPUS_ENTRIES.slice(0, 4)),
      3600n,
      20n, // short 20s reveal window for live anti-grief proof
      20n, // short 20s audit duration (+ 30s grace = 50s) for live timeout proof
    ],
    value: 50n,
    followTree: true,
  });

  // 4A: Commit and let reveal window (20s) expire -> anti-grief 10% fee (5 wei) + 90% refund (45 wei) + corpus re-opens!
  await runResumableTx({
    stepKey: 'case4a_commit_unrevealed',
    caseId: 'case4_deterministic_fallbacks',
    actorName: 'auditor',
    client: auditor.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'commit_audit',
    args: [fallbackCorpusId, sha256('never-revealed-secret')],
    value: 50n,
  });
  if (!loadState().txs?.case4a_expire_unrevealed?.statusName) {
    console.log('  [WAIT] Waiting 25s for 20s reveal_deadline to pass...');
    await sleep(25000);
  }
  await runResumableTx({
    stepKey: 'case4a_expire_unrevealed',
    caseId: 'case4_deterministic_fallbacks',
    actorName: 'publisher',
    client: publisher.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'expire_unrevealed_audit',
    args: [unrevealedAuditId],
  });

  // 4B: Commit on the RE-OPENED corpus -> late reveal rejected with REVEAL_DEADLINE_PASSED (expected failure proof)
  //     -> expire_unrevealed_audit(4) cleanly re-opens corpus and credits refunds!
  const salt4b = 'verity-stalled-fallback-salt-2026';
  await runResumableTx({
    stepKey: 'case4b_commit_reopened',
    caseId: 'case4_deterministic_fallbacks',
    actorName: 'auditor',
    client: auditor.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'commit_audit',
    args: [fallbackCorpusId, sha256(salt4b)],
    value: 50n,
  });
  await runResumableTx({
    stepKey: 'case4b_reveal_seed',
    caseId: 'case4_deterministic_fallbacks',
    actorName: 'auditor',
    client: auditor.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'reveal_audit_seed',
    args: [stalledAuditId, salt4b],
    allowError: true, // Expected finalized failure: REVEAL_DEADLINE_PASSED (20s window elapsed during finality)
  });
  await runResumableTx({
    stepKey: 'case4b_expire_late_audit',
    caseId: 'case4_deterministic_fallbacks',
    actorName: 'publisher',
    client: publisher.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'expire_unrevealed_audit',
    args: [stalledAuditId],
  });

  // Cleanly settle remaining claimable/refundable balances so vault reaches clean post-demo accounting!
  await runResumableTx({
    stepKey: 'case4_publisher_claim_antigrief',
    caseId: 'case4_deterministic_fallbacks',
    actorName: 'publisher',
    client: publisher.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'claim_winnings',
    args: [],
  });
  await runResumableTx({
    stepKey: 'case4_auditor_withdraw_refund',
    caseId: 'case4_deterministic_fallbacks',
    actorName: 'auditor',
    client: auditor.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'withdraw_refund',
    args: [],
  });

  // -------------------------------------------------------------------------
  // Export Public Proof Manifest (deploy/proof.json)
  // -------------------------------------------------------------------------
  console.log('\n[PROOF] Snapshotting finalized on-chain state to deploy/proof.json...');
  const protocolInfo = await readJsonView(deployer.client, vaultAddr, 'get_protocol_info', []);
  const judgeInfo = await readJsonView(deployer.client, judgeAddr, 'get_judge_info', []);
  const corpora: any[] = [];
  for (let i = 1; i <= Number(protocolInfo.corpus_count); i++) {
    corpora.push(await readJsonView(deployer.client, vaultAddr, 'get_corpus', [BigInt(i)]));
  }
  const audits: any[] = [];
  for (let i = 1; i <= Number(protocolInfo.audit_count); i++) {
    audits.push(await readJsonView(deployer.client, vaultAddr, 'get_audit', [BigInt(i)]));
  }

  let gitCommit = 'uncommitted';
  try {
    gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    gitCommit = 'pending-initial-commit';
  }

  const finalSt = loadState();
  const probeReportPath = path.resolve('deploy/probe_report.json');
  const probeReport = fs.existsSync(probeReportPath) ? JSON.parse(fs.readFileSync(probeReportPath, 'utf-8')) : null;

  const proof = {
    project: 'Verity',
    tagline: 'Risk-Limiting Sequential Audit Protocol (Wald SPRT) for Citation & Claim Grounding on GenLayer',
    generatedAt: new Date().toISOString(),
    sourceCommit: gitCommit,
    network: {
      name: 'GenLayer StudioNet',
      chainId: STUDIONET_CHAIN_ID,
      rpcUrl: STUDIONET_RPC,
      explorerUrl: STUDIONET_EXPLORER,
      pinnedRunner: 'py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6',
    },
    actors: {
      deployer: deployer.account.address,
      publisher: publisher.account.address,
      auditor: auditor.account.address,
    },
    contracts: {
      evidenceProbe: probeReport
        ? {
            address: probeReport.probeAddress,
            deployTx: probeReport.probeDeployTx,
            sourcePath: 'contracts/evidence_probe.py',
            sourceSha256: probeReport.probeSourceSha256,
            blobSha1: probeReport.probeBlobSha1,
            explorerUrl: `${STUDIONET_EXPLORER}/address/${probeReport.probeAddress}`,
          }
        : null,
      verityCitationJudge: {
        address: judgeAddr,
        deployTx: finalSt.judgeDeployTx,
        sourcePath: 'contracts/verity_citation_judge.py',
        sourceSha256: judgeSrc.sha256Hex,
        blobSha1: judgeSrc.blobSha1,
        explorerUrl: `${STUDIONET_EXPLORER}/address/${judgeAddr}`,
      },
      verityAuditVault: {
        address: vaultAddr,
        deployTx: finalSt.vaultDeployTx,
        sourcePath: 'contracts/verity_audit_vault.py',
        sourceSha256: vaultSrc.sha256Hex,
        blobSha1: vaultSrc.blobSha1,
        explorerUrl: `${STUDIONET_EXPLORER}/address/${vaultAddr}`,
      },
    },
    onChainState: {
      protocolInfo,
      judgeInfo,
      corpora,
      audits,
    },
    transactions: Object.values(finalSt.txs || {}),
    evidenceProbeSummary: probeReport?.results || {},
  };

  fs.mkdirSync(path.resolve('deploy'), { recursive: true });
  fs.writeFileSync(path.resolve('deploy/proof.json'), JSON.stringify(proof, null, 2) + '\n', 'utf-8');
  console.log('\n===================================================================');
  console.log('   ALL LIVE STUDIONET DEMO CASES FINALIZED SUCCESSFULLY!');
  console.log(`   VerityCitationJudge: ${judgeAddr}`);
  console.log(`   VerityAuditVault   : ${vaultAddr}`);
  console.log(`   Conservation OK    : ${protocolInfo.conservation_ok}`);
  console.log(`   Proof manifest     : deploy/proof.json`);
  console.log('===================================================================');
}

main().catch((err) => {
  console.error('\nDeployment/Demo failed:', err);
  process.exit(1);
});
