import fs from 'node:fs';
import path from 'node:path';
import { createClient, chains } from 'genlayer-js';
import { loadContractLF, rpcCall, STUDIONET_RPC, sleep } from './studionet.ts';

async function main() {
  console.log('===================================================================');
  console.log('   Verity — Read-Only On-Chain Proof Verifier (npm run verify:proof)');
  console.log('===================================================================');

  const proofPath = path.resolve('deploy/proof.json');
  if (!fs.existsSync(proofPath)) {
    throw new Error('deploy/proof.json not found. Run npm run deploy:studionet first.');
  }
  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf-8'));

  // 1. Verify local LF contract source hashes match recorded proof manifest
  console.log('\n[1/3] Checking byte-for-byte contract source hashes...');
  for (const key of ['verityCitationJudge', 'verityAuditVault'] as const) {
    const meta = proof.contracts[key];
    const local = loadContractLF(meta.sourcePath);
    if (local.sha256Hex !== meta.sourceSha256 || local.blobSha1 !== meta.blobSha1) {
      throw new Error(
        `Source hash mismatch for ${meta.sourcePath}: local=${local.sha256Hex} vs proof=${meta.sourceSha256}`
      );
    }
    console.log(`  OK ${meta.sourcePath}`);
    console.log(`     address: ${meta.address}`);
    console.log(`     sha256 : ${local.sha256Hex}`);
    console.log(`     blob   : ${local.blobSha1}`);
  }

  // 2. Verify live StudioNet contract state & conservation invariant (read-only)
  console.log('\n[2/3] Querying live VerityAuditVault & VerityCitationJudge on StudioNet...');
  const client = createClient({
    chain: {
      ...chains.studionet,
      rpcUrls: { default: { http: [STUDIONET_RPC] } },
    },
  });

  const vaultAddr = proof.contracts.verityAuditVault.address as `0x${string}`;
  const judgeAddr = proof.contracts.verityCitationJudge.address as `0x${string}`;

  const liveProtocol: any = await client.readContract({
    address: vaultAddr,
    functionName: 'get_protocol_info',
    args: [],
  });
  const liveJudge: any = await client.readContract({
    address: judgeAddr,
    functionName: 'get_judge_info',
    args: [],
  });

  if (!liveProtocol?.conservation_ok) {
    throw new Error(`Conservation invariant FAILED live on StudioNet: ${JSON.stringify(liveProtocol)}`);
  }
  if (String(liveJudge?.vault_address).toLowerCase() !== vaultAddr.toLowerCase() || !liveJudge?.vault_bound) {
    throw new Error(`Judge vault binding mismatch: ${JSON.stringify(liveJudge)}`);
  }
  console.log(
    `  OK Live Vault: corpora=${liveProtocol.corpus_count}, audits=${liveProtocol.audit_count}, inbound=${liveProtocol.total_inbound_wei} wei, outbound=${liveProtocol.total_outbound_wei} wei, conservation_ok=${liveProtocol.conservation_ok}`
  );
  console.log(
    `  OK Live Judge: bound=${liveJudge.vault_bound}, vettings=${liveJudge.vettings_completed}, samples_judged=${liveJudge.samples_judged}`
  );

  // 3. Re-verify all recorded transaction hashes (parent + emitted finality callbacks) on StudioNet RPC
  console.log('\n[3/3] Re-verifying finalized transaction receipts on StudioNet RPC...');
  const allHashes: Array<{ label: string; hash: string; allowError?: boolean }> = [
    { label: 'deploy_judge', hash: proof.contracts.verityCitationJudge.deployTx },
    { label: 'deploy_vault', hash: proof.contracts.verityAuditVault.deployTx },
  ];
  for (const tx of proof.transactions) {
    allHashes.push({
      label: tx.step,
      hash: tx.txHash,
      allowError: tx.executionResult === 'ERROR',
    });
    for (let i = 0; i < (tx.emittedChildren || []).length; i++) {
      allHashes.push({
        label: `${tx.step}::child_${i + 1}`,
        hash: tx.emittedChildren[i].txHash,
        allowError: tx.emittedChildren[i].executionResult === 'ERROR',
      });
    }
  }

  let verifiedCount = 0;
  for (const item of allHashes) {
    const rpcTx = await rpcCall('eth_getTransactionByHash', [item.hash]);
    if (!rpcTx) {
      throw new Error(`Transaction not found on StudioNet: ${item.label} (${item.hash})`);
    }
    const changes: string[] = rpcTx?.consensus_history?.current_status_changes || [];
    const status = rpcTx?.status_name || (changes.includes('FINALIZED') ? 'FINALIZED' : 'UNKNOWN');
    const lr = rpcTx?.consensus_data?.leader_receipt?.[0];
    const exec = lr?.execution_result || 'UNKNOWN';
    if (status !== 'FINALIZED' || (!item.allowError && exec !== 'SUCCESS')) {
      throw new Error(`Tx ${item.label} (${item.hash}) invalid live state: status=${status}, exec=${exec}`);
    }
    verifiedCount++;
    console.log(`  [${verifiedCount}/${allHashes.length}] FINALIZED ${exec} | ${item.label} | ${item.hash}`);
    await sleep(2200);
  }

  console.log('\n===================================================================');
  console.log(`   PROOF VERIFICATION PASSED: ${verifiedCount}/${allHashes.length} finalized txs verified live!`);
  console.log('===================================================================');
}

main().catch((err) => {
  console.error('\nProof verification FAILED:', err);
  process.exit(1);
});
