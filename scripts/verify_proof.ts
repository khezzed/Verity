import fs from 'node:fs';
import path from 'node:path';
import { createClient, chains } from 'genlayer-js';
import { loadContractLF, rpcCall, sha256, STUDIONET_RPC, sleep } from './studionet.ts';

async function main() {
  console.log('===================================================================');
  console.log('   Verity — Read-Only On-Chain Proof Verifier (npm run verify:proof)');
  console.log('===================================================================');

  const proofPath = path.resolve('deploy/proof.json');
  if (!fs.existsSync(proofPath)) {
    throw new Error('deploy/proof.json not found. Run npm run deploy:studionet first.');
  }
  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf-8'));

  // 1. Verify LIVE ON-CHAIN contract source byte-for-byte against local repo files via gen_getContractCode
  console.log('\n[1/3] Checking LIVE on-chain source equality via gen_getContractCode...');
  for (const key of ['verityCitationJudge', 'verityAuditVault'] as const) {
    const meta = proof.contracts[key];
    const local = loadContractLF(meta.sourcePath);
    if (local.sha256Hex !== meta.sourceSha256 || local.blobSha1 !== meta.blobSha1) {
      throw new Error(`Manifest hash mismatch for ${meta.sourcePath}`);
    }
    const onChainB64: string = await rpcCall('gen_getContractCode', [meta.address]);
    if (!onChainB64 || typeof onChainB64 !== 'string') {
      throw new Error(`gen_getContractCode returned empty code for ${meta.address}`);
    }
    const onChainBuf = Buffer.from(onChainB64, 'base64');
    const onChainSha = sha256(onChainBuf);
    if (onChainSha !== local.sha256Hex) {
      throw new Error(
        `ON-CHAIN SOURCE MISMATCH for ${meta.sourcePath}: on-chain=${onChainSha} vs repo=${local.sha256Hex}`
      );
    }
    console.log(`  OK ${meta.sourcePath} == LIVE ON-CHAIN SOURCE (100% byte-identical)`);
    console.log(`     address: ${meta.address}`);
    console.log(`     sha256 : ${onChainSha} (${onChainBuf.length} bytes)`);
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
    `  OK Live Vault: corpora=${liveProtocol.corpus_count}, audits=${liveProtocol.audit_count}, inbound=${liveProtocol.total_inbound_wei} wei, outbound=${liveProtocol.total_outbound_wei} wei, balance=${liveProtocol.contract_balance_wei} wei, conservation_ok=${liveProtocol.conservation_ok}`
  );
  console.log(
    `  OK Live Judge: bound=${liveJudge.vault_bound}, vettings=${liveJudge.vettings_completed}, samples_judged=${liveJudge.samples_judged}`
  );

  // 3. Re-verify all recorded transaction hashes (parent + GenVM finality callbacks + Type 0 EOA value transfers)
  console.log('\n[3/3] Re-verifying finalized transaction receipts on StudioNet RPC...');
  const allHashes: Array<{ label: string; hash: string; allowError?: boolean; isEoaTransfer?: boolean }> = [
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
      const ch = tx.emittedChildren[i];
      allHashes.push({
        label: `${tx.step}::child_${i + 1}${ch.kind === 'eoa_value_transfer' ? '(EOA)' : ''}`,
        hash: ch.txHash,
        allowError: ch.executionResult === 'ERROR',
        isEoaTransfer: ch.kind === 'eoa_value_transfer',
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
    if (item.isEoaTransfer || rpcTx?.type === 0) {
      if (status !== 'FINALIZED') {
        throw new Error(`EOA transfer ${item.label} (${item.hash}) not FINALIZED: status=${status}`);
      }
      verifiedCount++;
      console.log(
        `  [${verifiedCount}/${allHashes.length}] FINALIZED EOA_TRANSFER (${rpcTx?.value} wei) | ${item.label} | ${item.hash}`
      );
    } else {
      const lr = rpcTx?.consensus_data?.leader_receipt?.[0];
      const exec = lr?.execution_result || 'UNKNOWN';
      if (status !== 'FINALIZED' || (!item.allowError && exec !== 'SUCCESS')) {
        throw new Error(`Tx ${item.label} (${item.hash}) invalid live state: status=${status}, exec=${exec}`);
      }
      verifiedCount++;
      console.log(`  [${verifiedCount}/${allHashes.length}] FINALIZED ${exec} | ${item.label} | ${item.hash}`);
    }
    await sleep(2100);
  }

  console.log('\n===================================================================');
  console.log(`   PROOF VERIFICATION PASSED: ${verifiedCount}/${allHashes.length} finalized txs + live source equality verified!`);
  console.log('===================================================================');
}

main().catch((err) => {
  console.error('\nProof verification FAILED:', err);
  process.exit(1);
});
