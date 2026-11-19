import { createClient, chains } from 'genlayer-js';
import type {
  AuditRecord,
  CorpusRecord,
  JudgeInfo,
  ProtocolInfo,
  TrackedTxPhase,
} from '../types/verity';

export const STUDIONET_RPC = 'https://studio.genlayer.com/api';
export const STUDIONET_EXPLORER = 'https://explorer-studio.genlayer.com';
export const STUDIONET_CHAIN_ID = 61999;
export const STUDIONET_CHAIN_HEX = '0xf22f';

export function createReadClient() {
  return createClient({
    chain: {
      ...chains.studionet,
      rpcUrls: { default: { http: [STUDIONET_RPC] } },
    },
  });
}

export function createWalletClient(accountAddress: `0x${string}`) {
  return createClient({
    chain: {
      ...chains.studionet,
      rpcUrls: { default: { http: [STUDIONET_RPC] } },
    },
    account: accountAddress,
  });
}

function parseMaybeJson<T>(raw: unknown): T {
  if (typeof raw === 'string') {
    return JSON.parse(raw) as T;
  }
  return raw as T;
}

export async function fetchLiveSnapshot(
  vaultAddress: `0x${string}`,
  judgeAddress: `0x${string}`
): Promise<{
  protocolInfo: ProtocolInfo;
  judgeInfo: JudgeInfo;
  corpora: CorpusRecord[];
  audits: AuditRecord[];
  fetchedAt: string;
}> {
  const client = createReadClient();
  const [protocolInfoRaw, judgeInfoRaw] = await Promise.all([
    client.readContract({
      address: vaultAddress,
      functionName: 'get_protocol_info',
      args: [],
    }),
    client.readContract({
      address: judgeAddress,
      functionName: 'get_judge_info',
      args: [],
    }),
  ]);
  const protocolInfo = protocolInfoRaw as unknown as ProtocolInfo;
  const judgeInfo = judgeInfoRaw as unknown as JudgeInfo;

  const corpusCount = Number(protocolInfo.corpus_count || 0);
  const auditCount = Number(protocolInfo.audit_count || 0);

  const corpora: CorpusRecord[] = [];
  for (let i = 1; i <= corpusCount; i++) {
    const raw = await client.readContract({
      address: vaultAddress,
      functionName: 'get_corpus',
      args: [BigInt(i)],
    });
    if (raw) corpora.push(parseMaybeJson<CorpusRecord>(raw));
  }

  const audits: AuditRecord[] = [];
  for (let i = 1; i <= auditCount; i++) {
    const raw = await client.readContract({
      address: vaultAddress,
      functionName: 'get_audit',
      args: [BigInt(i)],
    });
    if (raw) audits.push(parseMaybeJson<AuditRecord>(raw));
  }

  return {
    protocolInfo,
    judgeInfo,
    corpora,
    audits,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchAccountBalances(
  vaultAddress: `0x${string}`,
  accountAddress: string
): Promise<{ claimable_wei: number; refundable_wei: number }> {
  const client = createReadClient();
  const res = (await client.readContract({
    address: vaultAddress,
    functionName: 'get_account_balances',
    args: [accountAddress],
  })) as { claimable_wei: number | bigint; refundable_wei: number | bigint };
  return {
    claimable_wei: Number(res?.claimable_wei ?? 0),
    refundable_wei: Number(res?.refundable_wei ?? 0),
  };
}

export async function sha256HexBrowser(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function connectStudioNetWallet(): Promise<`0x${string}`> {
  const eth = (window as unknown as { ethereum?: any }).ethereum;
  if (!eth) {
    throw new Error('No browser wallet detected. Install MetaMask or an EIP-1193 wallet to execute live writes.');
  }
  const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
  if (!accounts || accounts.length === 0) {
    throw new Error('Wallet connection rejected.');
  }
  try {
    await eth.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: STUDIONET_CHAIN_HEX }],
    });
  } catch (err: any) {
    if (err?.code === 4902) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: STUDIONET_CHAIN_HEX,
            chainName: 'GenLayer StudioNet',
            nativeCurrency: { name: 'GEN', symbol: 'GEN', decimals: 18 },
            rpcUrls: [STUDIONET_RPC],
            blockExplorerUrls: [STUDIONET_EXPLORER],
          },
        ],
      });
    }
  }
  return accounts[0] as `0x${string}`;
}

export async function pollTxPhase(txHash: string): Promise<{
  phase: TrackedTxPhase;
  consensusResult?: string;
  childHashes?: string[];
  errorDetail?: string;
}> {
  const client = createReadClient();
  try {
    const tx: any = await client.getTransaction({ hash: txHash as any });
    if (!tx) {
      return { phase: 'submitted' };
    }
    const changes: string[] = tx?.consensus_history?.current_status_changes || [];
    const statusName: string =
      tx?.statusName ||
      tx?.status_name ||
      (changes.includes('FINALIZED') ? 'FINALIZED' : changes[changes.length - 1] || 'PENDING');
    const resultName: string = tx?.result_name || tx?.resultName || '';
    const lr = tx?.consensus_data?.leader_receipt?.[0];
    const execResult: string = lr?.execution_result || '';
    const children: string[] = Array.isArray(tx?.triggered_transactions) ? tx.triggered_transactions : [];
    const stderr: string = lr?.genvm_result?.stderr || '';

    if (statusName === 'FINALIZED') {
      if (execResult === 'ERROR') {
        return {
          phase: 'finalized-error',
          consensusResult: resultName,
          childHashes: children,
          errorDetail: stderr || 'Finalized execution error',
        };
      }
      return {
        phase: 'finalized-success',
        consensusResult: resultName || 'MAJORITY_AGREE',
        childHashes: children,
      };
    }
    if (statusName === 'UNDETERMINED' || statusName === 'CANCELED') {
      return {
        phase: 'finalized-error',
        consensusResult: resultName || statusName,
        childHashes: children,
        errorDetail: `Transaction ended as ${statusName}`,
      };
    }
    if (statusName === 'ACCEPTED') {
      return {
        phase: 'accepted',
        consensusResult: resultName,
        childHashes: children,
      };
    }
    return {
      phase: 'pending',
      consensusResult: statusName,
      childHashes: children,
    };
  } catch {
    return { phase: 'pending' };
  }
}

export function shortHex(hex: string, head = 6, tail = 4): string {
  if (!hex || hex.length <= head + tail + 2) return hex || '—';
  return `${hex.slice(0, head + 2)}…${hex.slice(-tail)}`;
}

export function formatLlr(scaled: number): string {
  const v = scaled / 1_000_000;
  return `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
}
