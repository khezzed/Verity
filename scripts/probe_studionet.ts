import fs from 'node:fs';
import path from 'node:path';
import {
  getOrCreateActor,
  loadContractLF,
  loadState,
  saveState,
  ensureFunded,
  callWithRetry,
  waitForFinalized,
  waitForFinalizedTree,
  sleep,
  STUDIONET_EXPLORER,
} from './studionet.ts';

const PROBE_TARGETS: Array<{ label: string; url: string; anchor: string; note: string }> = [
  {
    label: 'rfc_2104',
    url: 'https://www.rfc-editor.org/rfc/rfc2104.txt',
    anchor: '0x36',
    note: 'IETF RFC 2104 (HMAC, 1997)',
  },
  {
    label: 'rfc_8259',
    url: 'https://www.rfc-editor.org/rfc/rfc8259.txt',
    anchor: 'UTF-8',
    note: 'IETF RFC 8259 (JSON, 2017)',
  },
  {
    label: 'rfc_6962',
    url: 'https://www.rfc-editor.org/rfc/rfc6962.txt',
    anchor: 'SHA-256',
    note: 'IETF RFC 6962 (Certificate Transparency, 2013)',
  },
  {
    label: 'wiki_merkle_2009',
    url: 'https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&format=json&formatversion=2&revids=333954216',
    anchor: 'hash tree',
    note: 'Wikipedia Permanent Revision 333954216 (Merkle tree, Dec 2009)',
  },
  {
    label: 'github_prompt_injection',
    url: 'https://raw.githubusercontent.com/liu00222/Open-Prompt-Injection/fbed5cca347488f88363790ae3ae97c56116da6a/OpenPromptInjection/attackers/IgnoreAttacker.py',
    anchor: 'Ignore',
    note: 'Third-party pinned GitHub commit containing real prompt-injection payload',
  },
  {
    label: 'archive_hashcash_2004',
    url: 'https://web.archive.org/web/20040326113623id_/http://www.hashcash.org/faq/',
    anchor: 'hashcash',
    note: 'Archive.org raw id_ capture (Hashcash FAQ, 2004-03-26)',
  },
  {
    label: 'archive_hashcash_cdx',
    url: 'https://web.archive.org/cdx/search/cdx?url=http://www.hashcash.org/faq/&output=json&filter=timestamp:20040326113623',
    anchor: '20040326113623',
    note: 'Archive.org CDX capture existence index',
  },
];

async function main() {
  console.log('===============================================================');
  console.log('   Verity — Step 2: Live StudioNet Network & Evidence Probe');
  console.log('===============================================================');

  const { client, account } = getOrCreateActor('deployer');
  console.log(`Deployer: ${account.address}`);
  await ensureFunded(account.address, 1000n);

  const { code: probeCode, sha256Hex: probeSha, blobSha1 } = loadContractLF('contracts/evidence_probe.py');
  let state = loadState();

  // 1. Deploy EvidenceProbe (resumable)
  let probeAddr: string | undefined = state.probeAddress;
  if (!probeAddr) {
    let deployTx: string | undefined = state.probeDeployTx;
    if (!deployTx) {
      console.log('\n[1/4] Deploying contracts/evidence_probe.py to StudioNet...');
      deployTx = await callWithRetry(() => client.deployContract({ code: probeCode }));
      console.log(`  Deploy tx: ${deployTx}`);
      saveState({ probeDeployTx: deployTx, probeSourceSha256: probeSha, probeBlobSha1: blobSha1 });
    }
    const receipt = await waitForFinalized(client, deployTx!);
    probeAddr = receipt.contractAddress;
    if (!probeAddr) throw new Error('No contractAddress returned for EvidenceProbe');
    saveState({ probeAddress: probeAddr });
    console.log(`  EvidenceProbe FINALIZED at: ${probeAddr}`);
    console.log(`  Explorer: ${STUDIONET_EXPLORER}/address/${probeAddr}`);
    await sleep(5000);
  } else {
    console.log(`Reusing deployed EvidenceProbe at: ${probeAddr}`);
  }

  // 2. Test emit(on='finalized') callback delivery
  state = loadState();
  if (!state.probeCallback?.finalized) {
    console.log('\n[2/4] Probing emit(on="finalized") callback delivery...');
    let cbTx: string | undefined = state.probeCallback?.txHash;
    if (!cbTx) {
      cbTx = await callWithRetry(() =>
        client.writeContract({
          address: probeAddr as `0x${string}`,
          functionName: 'trigger_finalized_callback',
          args: ['probe_cb_1'],
          value: 0n,
        })
      );
      saveState({ probeCallback: { txHash: cbTx, finalized: false } });
      console.log(`  Submitted callback parent tx: ${cbTx}`);
    }
    const tree = await waitForFinalizedTree(client, cbTx!, { allowError: true, maxAttempts: 60 });
    const cbStatus = await callWithRetry(() =>
      client.readContract({
        address: probeAddr as `0x${string}`,
        functionName: 'get_callback_status',
        args: ['probe_cb_1'],
      })
    );
    saveState({
      probeCallback: {
        txHash: cbTx,
        finalized: true,
        parentStatus: tree.parent.statusName,
        childCount: tree.children.length,
        childHashes: tree.children.map((c) => c.txHash),
        cbStatus,
      },
    });
    console.log(`  Callback result: status=${cbStatus}, emitted_children=${tree.children.length}`);
    await sleep(5000);
  } else {
    console.log(`[SKIP] Callback probe already verified: ${JSON.stringify(state.probeCallback)}`);
  }

  // 3. Test 1-wei payable + emit_transfer(on='finalized')
  state = loadState();
  if (!state.probeRefund?.finalized) {
    console.log('\n[3/4] Probing 1-wei payable + emit_transfer(on="finalized")...');
    let refTx: string | undefined = state.probeRefund?.txHash;
    if (!refTx) {
      refTx = await callWithRetry(() =>
        client.writeContract({
          address: probeAddr as `0x${string}`,
          functionName: 'test_payable_refund',
          args: [],
          value: 1n,
        })
      );
      saveState({ probeRefund: { txHash: refTx, finalized: false } });
      console.log(`  Submitted 1-wei payable tx: ${refTx}`);
    }
    const tree = await waitForFinalizedTree(client, refTx!, { allowError: true, maxAttempts: 60 });
    const summary = await callWithRetry(() =>
      client.readContract({
        address: probeAddr as `0x${string}`,
        functionName: 'get_summary',
        args: [],
      })
    );
    saveState({
      probeRefund: {
        txHash: refTx,
        finalized: true,
        parentStatus: tree.parent.statusName,
        parentExec: tree.parent.executionResult,
        childCount: tree.children.length,
        summary,
      },
    });
    console.log(`  1-wei Payable + Refund result: exec=${tree.parent.executionResult}, summary=${JSON.stringify(summary)}`);
    await sleep(5000);
  } else {
    console.log(`[SKIP] 1-wei payable refund already verified: ${JSON.stringify(state.probeRefund)}`);
  }

  // 4. Probe each evidence host from StudioNet validators
  console.log('\n[4/4] Probing immutable evidence hosts from StudioNet validators...');
  state = loadState();
  const probeResults: Record<string, any> = state.probeResults || {};

  for (const target of PROBE_TARGETS) {
    if (probeResults[target.label]?.finalized) {
      console.log(`  [SKIP] ${target.label}: already probed -> ${JSON.stringify(probeResults[target.label].parsed)}`);
      continue;
    }
    console.log(`\n  Probing [${target.label}]: ${target.url}`);
    let txHash: string | undefined = probeResults[target.label]?.txHash;
    if (!txHash) {
      txHash = await callWithRetry(() =>
        client.writeContract({
          address: probeAddr as `0x${string}`,
          functionName: 'probe_source',
          args: [target.label, target.url, target.anchor],
          value: 0n,
        })
      );
      probeResults[target.label] = { txHash, url: target.url, anchor: target.anchor, note: target.note, finalized: false };
      saveState({ probeResults });
      console.log(`    Submitted tx: ${txHash}`);
    }
    try {
      const receipt = await waitForFinalized(client, txHash!, { allowError: true, maxAttempts: 50 });
      let stored = '';
      if (receipt.statusName === 'FINALIZED' && receipt.executionResult === 'SUCCESS') {
        stored = await callWithRetry(() =>
          client.readContract({
            address: probeAddr as `0x${string}`,
            functionName: 'get_result',
            args: [target.label],
          })
        );
      }
      let parsed: any = null;
      try {
        parsed = stored ? JSON.parse(stored) : null;
      } catch {
        parsed = stored;
      }
      probeResults[target.label] = {
        txHash,
        url: target.url,
        anchor: target.anchor,
        note: target.note,
        finalized: receipt.statusName === 'FINALIZED',
        statusName: receipt.statusName,
        resultName: receipt.resultName,
        executionResult: receipt.executionResult,
        parsed,
        stderr: receipt.stderr ? receipt.stderr.slice(0, 260) : '',
      };
      saveState({ probeResults });
      console.log(`    RESULT [${target.label}]: status=${receipt.statusName} exec=${receipt.executionResult}`);
      console.log(`    DATA: ${JSON.stringify(parsed)}`);
    } catch (err: any) {
      console.error(`    FAILED [${target.label}]: ${err.message}`);
      probeResults[target.label] = {
        txHash,
        url: target.url,
        anchor: target.anchor,
        note: target.note,
        finalized: false,
        error: err.message,
      };
      saveState({ probeResults });
    }
    await sleep(5000);
  }

  // Write public non-secret probe report
  const finalState = loadState();
  const report = {
    network: 'studionet',
    chainId: 61999,
    probeAddress: probeAddr,
    probeDeployTx: finalState.probeDeployTx,
    probeSourceSha256: probeSha,
    probeBlobSha1: blobSha1,
    callbackProbe: finalState.probeCallback,
    payableRefundProbe: finalState.probeRefund,
    probedAt: new Date().toISOString(),
    results: probeResults,
  };
  fs.mkdirSync(path.resolve('deploy'), { recursive: true });
  fs.writeFileSync(path.resolve('deploy/probe_report.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8');
  console.log('\nSaved public probe report to deploy/probe_report.json');
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
