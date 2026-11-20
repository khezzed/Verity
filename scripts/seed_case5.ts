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

const CASE5_MIXED_ENTRIES = [
  {
    claim: 'The archived December 2009 Wikipedia revision describes hash trees (or Merkle trees) as a data structure used in cryptography and computer science.',
    source_url:
      'https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&format=json&formatversion=2&revids=333954216',
    anchor: 'hash tree',
  },
  {
    claim: 'The archived March 2004 Hashcash FAQ states that including a message body hash prevents race-conditions being used as a denial-of-service, and notes that PGP and S/MIME apply text canonicalization and MIME encoding.',
    source_url: 'https://web.archive.org/web/20040326113623id_/http://www.hashcash.org/faq/',
    anchor: 'denial-of-service',
  },
  {
    claim: 'RFC 8259 states that JSON text exchanged between systems not part of a closed ecosystem MUST be encoded using UTF-8.',
    source_url: 'https://www.rfc-editor.org/rfc/rfc8259.txt',
    anchor: 'UTF-8',
  },
  {
    claim: 'The archived December 2009 Wikipedia revision states that Merkle trees were first invented in 2019 exclusively for quantum key distribution.',
    source_url:
      'https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&format=json&formatversion=2&revids=333954216',
    anchor: 'hash tree',
  },
];

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
}) {
  const st = loadState();
  const existing = st.txs?.[params.stepKey];
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

  const rec = {
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
  const cur = loadState();
  const txs = cur.txs || {};
  txs[params.stepKey] = rec;
  saveState({ txs });
  await sleep(4500);
  return rec;
}

async function enrichPayoutChildren(txs: any[]) {
  for (const tx of txs) {
    if (
      (tx.method === 'claim_winnings' || tx.method === 'withdraw_refund') &&
      (!tx.emittedChildren || tx.emittedChildren.length === 0)
    ) {
      const rpcTx = await callWithRetry(() => rpcCall('eth_getTransactionByHash', [tx.txHash]));
      const childHashes: string[] = Array.isArray(rpcTx?.triggered_transactions) ? rpcTx.triggered_transactions : [];
      const enriched: any[] = [];
      for (const ch of childHashes) {
        const cTx = await callWithRetry(() => rpcCall('eth_getTransactionByHash', [ch]));
        const changes: string[] = cTx?.consensus_history?.current_status_changes || [];
        const statusName = cTx?.status_name || (changes.includes('FINALIZED') ? 'FINALIZED' : 'PENDING');
        enriched.push({
          txHash: ch,
          kind: 'eoa_value_transfer',
          toAddress: cTx?.to_address || '',
          valueWei: Number(cTx?.value ?? 0),
          statusName,
          resultName: cTx?.result_name || 'EVM_TRANSFER',
          executionResult: statusName === 'FINALIZED' ? 'SUCCESS' : 'PENDING',
          returnReadable: `EOA transfer ${Number(cTx?.value ?? 0)} wei -> ${cTx?.to_address || ''}`,
          explorerUrl: `${STUDIONET_EXPLORER}/transactions/${ch}`,
        });
        await sleep(1200);
      }
      tx.emittedChildren = enriched;
    }
  }
}

async function main() {
  console.log('======================================================================');
  console.log('   Verity — Case 5 Live Seed (Wiki + Archive + Mixed SPRT + Timeout)');
  console.log('======================================================================');

  const st = loadState();
  const vaultAddr: string = st.vaultAddress;
  const judgeAddr: string = st.judgeAddress;
  if (!vaultAddr || !judgeAddr) {
    throw new Error('Missing vaultAddress or judgeAddress in deploy/state.json');
  }

  const deployer = getOrCreateActor('deployer');
  const publisher = getOrCreateActor('publisher');
  const auditor = getOrCreateActor('auditor');
  await ensureFunded(publisher.account.address, 1000n);
  await ensureFunded(auditor.account.address, 1000n);

  // 1. Submit Corpus #5 (3 TRUE [Wiki, Archive.org, RFC] + 1 FALSE [Wiki])
  // audit_duration_sec=240 + grace=30 = 270s total: plenty for 2-3 samples, then expires cleanly!
  await runResumableTx({
    stepKey: 'case5_submit_mixed_corpus',
    caseId: 'case5_mixed_and_timeout',
    actorName: 'publisher',
    client: publisher.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'submit_corpus',
    args: [
      'Wikipedia & Archive.org Mixed-Integrity Audit Brief',
      OBJECTIVE_GROUNDING_RULE,
      'STANDARD_90',
      JSON.stringify(CASE5_MIXED_ENTRIES),
      3600n,
      300n, // 300s reveal window
      240n, // 240s audit duration (+ 30s grace = 270s)
    ],
    value: 60n,
    followTree: true,
  });

  // 2. Commit & Reveal Audit #5
  const salt5 = 'verity-mixed-wiki-archive-2026';
  await runResumableTx({
    stepKey: 'case5_commit_audit',
    caseId: 'case5_mixed_and_timeout',
    actorName: 'auditor',
    client: auditor.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'commit_audit',
    args: [5n, sha256(salt5)],
    value: 60n,
  });

  await runResumableTx({
    stepKey: 'case5_reveal_seed',
    caseId: 'case5_mixed_and_timeout',
    actorName: 'auditor',
    client: auditor.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'reveal_audit_seed',
    args: [5n, salt5],
  });

  const a5Init = await readJsonView(deployer.client, vaultAddr, 'get_audit', [5n]);
  const order: number[] = a5Init.sample_order || [];
  const falsePos = order.indexOf(3);
  // Step enough draws to capture the mixed reversal (if entry 3 is in first 3 draws),
  // but never draw all 4 so Audit #5 remains ACTIVE in the CONTINUE corridor for live expire_stalled_audit!
  const targetSamples = falsePos === 2 ? 3 : 2;
  console.log(`  Audit #5 revealed order: [${order.join(', ')}] (false entry #3 at pos ${falsePos}) -> stepping ${targetSamples} samples`);

  for (let i = 1; i <= targetSamples; i++) {
    const curA = await readJsonView(deployer.client, vaultAddr, 'get_audit', [5n]);
    if (curA.samples.length >= i || curA.status !== 'ACTIVE') {
      console.log(`  [SKIP] case5_sample_${i}: already completed (samples=${curA.samples.length}, status=${curA.status})`);
      continue;
    }
    await runResumableTx({
      stepKey: `case5_sample_${i}`,
      caseId: 'case5_mixed_and_timeout',
      actorName: 'auditor',
      client: auditor.client,
      contractLabel: 'VerityAuditVault',
      address: vaultAddr,
      functionName: 'step_audit_sample',
      args: [5n],
      followTree: i < 3,
      allowError: i === 3, // Expected finalized error: AUDIT_DEADLINE_PASSED before grace expiry
    });
    const afterA = await readJsonView(deployer.client, vaultAddr, 'get_audit', [5n]);
    const last = afterA.samples[afterA.samples.length - 1];
    console.log(
      `    -> Sample #${i} (entry ${last?.entry_idx}): verdict=${last?.verdict}, LLR=${afterA.llr_scaled}, status=${afterA.status}`
    );
  }

  // 3. Wait until grace_deadline has passed, then prove expire_stalled_audit(5) live on StudioNet!
  const a5PreExpire = await readJsonView(deployer.client, vaultAddr, 'get_audit', [5n]);
  if (a5PreExpire.status === 'ACTIVE' || a5PreExpire.status === 'SAMPLE_IN_FLIGHT') {
    const nowSec = Math.floor(Date.now() / 1000);
    const waitSec = Math.max(0, Number(a5PreExpire.grace_deadline) - nowSec + 12);
    if (waitSec > 0) {
      console.log(`  [WAIT] Waiting ${waitSec}s for Audit #5 grace_deadline (${a5PreExpire.grace_deadline}) to pass...`);
      await sleep(waitSec * 1000);
    }
    await runResumableTx({
      stepKey: 'case5_expire_stalled_audit',
      caseId: 'case5_mixed_and_timeout',
      actorName: 'publisher',
      client: publisher.client,
      contractLabel: 'VerityAuditVault',
      address: vaultAddr,
      functionName: 'expire_stalled_audit',
      args: [5n],
    });
  }

  // 4. Withdraw both neutral refunds cleanly!
  await runResumableTx({
    stepKey: 'case5_publisher_withdraw_refund',
    caseId: 'case5_mixed_and_timeout',
    actorName: 'publisher',
    client: publisher.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'withdraw_refund',
    args: [],
  });
  await runResumableTx({
    stepKey: 'case5_auditor_withdraw_refund',
    caseId: 'case5_mixed_and_timeout',
    actorName: 'auditor',
    client: auditor.client,
    contractLabel: 'VerityAuditVault',
    address: vaultAddr,
    functionName: 'withdraw_refund',
    args: [],
  });

  // 5. Re-export complete deploy/proof.json & frontend/src/data/proof.json (with enriched EOA payout child hashes!)
  console.log('\n[PROOF] Re-snapshotting complete StudioNet state + EOA transfer children...');
  const finalSt = loadState();
  const txsList = Object.values(finalSt.txs || {});
  await enrichPayoutChildren(txsList);
  saveState({ txs: finalSt.txs });

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

  const judgeSrc = loadContractLF('contracts/verity_citation_judge.py');
  const vaultSrc = loadContractLF('contracts/verity_audit_vault.py');
  const probeReport = JSON.parse(fs.readFileSync(path.resolve('deploy/probe_report.json'), 'utf-8'));

  const actorBalancesWei: Record<string, string> = {};
  for (const [role, addr] of [
    ['deployer', deployer.account.address],
    ['publisher', publisher.account.address],
    ['auditor', auditor.account.address],
  ] as const) {
    const hex = await callWithRetry(() => rpcCall('eth_getBalance', [addr, 'latest']));
    actorBalancesWei[role] = BigInt(hex || '0x0').toString();
  }

  let gitCommit = 'e6a6a9d98dbaf3647403b89481f7becd709d306f';
  try {
    gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {}

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
    actorBalancesWei,
    contracts: {
      evidenceProbe: {
        address: probeReport.probeAddress,
        deployTx: probeReport.probeDeployTx,
        sourcePath: 'contracts/evidence_probe.py',
        sourceSha256: probeReport.probeSourceSha256,
        blobSha1: probeReport.probeBlobSha1,
        explorerUrl: `${STUDIONET_EXPLORER}/address/${probeReport.probeAddress}`,
      },
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
    transactions: txsList,
    evidenceProbeSummary: probeReport.results || {},
  };

  const outJson = JSON.stringify(proof, null, 2) + '\n';
  fs.writeFileSync(path.resolve('deploy/proof.json'), outJson, 'utf-8');
  fs.writeFileSync(path.resolve('frontend/src/data/proof.json'), outJson, 'utf-8');
  console.log('\n=== CASE 5 FINALIZED & PROOF MANIFEST UPDATED ===');
  console.log('Conservation OK:', protocolInfo.conservation_ok, 'Actor balances:', actorBalancesWei);
}

main().catch((err) => {
  console.error('Case 5 failed:', err);
  process.exit(1);
});
