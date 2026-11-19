import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createClient, chains, createAccount, generatePrivateKey } from 'genlayer-js';

// Send a browser User-Agent on all fetch requests (StudioNet RPC and public sources can 403 bare clients)
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const origFetch = globalThis.fetch;
globalThis.fetch = (url: any, init: any = {}) => {
  const headers = new Headers(init?.headers || {});
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', BROWSER_UA);
  }
  return origFetch(url, { ...init, headers });
};

export const STUDIONET_RPC = 'https://studio.genlayer.com/api';
export const STUDIONET_EXPLORER = 'https://explorer-studio.genlayer.com';
export const STUDIONET_CHAIN_ID = 61999;

const STATE_FILE = path.resolve('deploy/state.json');

export function sha256(content: string | Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function gitBlobSha1(buf: Buffer): string {
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf-8');
  return crypto.createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
}

export function loadContractLF(relPath: string): { code: string; sha256Hex: string; blobSha1: string } {
  const raw = fs.readFileSync(path.resolve(relPath));
  if (raw.includes(Buffer.from('\r\n'))) {
    throw new Error(`CRLF detected in ${relPath}; convert to LF before deploying for exact git/on-chain parity.`);
  }
  return {
    code: raw.toString('utf-8'),
    sha256Hex: sha256(raw),
    blobSha1: gitBlobSha1(raw),
  };
}

export function loadState(): Record<string, any> {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

export function saveState(patch: Record<string, any>): Record<string, any> {
  const current = loadState();
  const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
  return updated;
}

export function getOrCreateActor(role: string) {
  const state = loadState();
  const actors = state.actors || {};
  let pk: string | undefined = actors[role]?.privateKey;
  if (!pk || typeof pk !== 'string' || pk.length !== 66) {
    pk = generatePrivateKey();
    const acc = createAccount(pk as `0x${string}`);
    actors[role] = { privateKey: pk, address: acc.address };
    saveState({ actors });
  }
  const account = createAccount(pk as `0x${string}`);
  const client = createClient({
    chain: {
      ...chains.studionet,
      rpcUrls: {
        default: { http: [STUDIONET_RPC] },
      },
    },
    account,
  });
  return { client, account, privateKey: pk };
}

export async function rpcCall(method: string, params: any[] = []): Promise<any> {
  const resp = await fetch(STUDIONET_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  if (!resp.ok) {
    throw new Error(`RPC HTTP ${resp.status} for ${method}`);
  }
  const data: any = await resp.json();
  if (data.error) {
    throw new Error(`RPC error (${method}): ${JSON.stringify(data.error)}`);
  }
  return data.result;
}

export async function ensureFunded(address: string, minWei = 10n ** 18n): Promise<string> {
  const balHex = await callWithRetry(() => rpcCall('eth_getBalance', [address, 'latest']));
  const bal = BigInt(balHex || '0x0');
  if (bal >= minWei) {
    return bal.toString();
  }
  console.log(`  [FUND] Funding ${address} on StudioNet (current balance: ${bal} wei)...`);
  try {
    await callWithRetry(() => rpcCall('sim_fundAccount', [address, Number(10n ** 15n)]));
  } catch (err: any) {
    console.warn(`  [FUND] sim_fundAccount note: ${String(err?.message || err).slice(0, 140)}`);
  }
  await sleep(2500);
  const afterHex = await callWithRetry(() => rpcCall('eth_getBalance', [address, 'latest']));
  const after = BigInt(afterHex || '0x0');
  console.log(`  [FUND] Balance for ${address}: ${after} wei`);
  return after.toString();
}

export async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export async function callWithRetry<T>(fn: () => Promise<T>, retries = 6, baseDelayMs = 4000): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const msg = err?.message || String(err);
      console.warn(`  [Retry ${attempt}/${retries}] ${msg.slice(0, 200)}`);
      await sleep(baseDelayMs * attempt);
    }
  }
  throw lastErr;
}

export interface FinalizedReceipt {
  txHash: string;
  statusName: string;
  resultName: string;
  executionResult: string;
  returnReadable: any;
  contractAddress?: string;
  triggeredTransactions: string[];
  rawTx: any;
  stderr?: string;
}

/**
 * Polls StudioNet every 9 seconds (respecting 30 req/min rate limit) until terminal FINALIZED state.
 */
export async function waitForFinalized(
  client: any,
  txHash: string,
  options: { maxAttempts?: number; pollMs?: number; allowError?: boolean } = {}
): Promise<FinalizedReceipt> {
  const maxAttempts = options.maxAttempts ?? 80;
  const pollMs = options.pollMs ?? 9000;
  const allowError = options.allowError ?? false;

  console.log(`  [POLL] Waiting for FINALIZED: ${txHash} (every ${pollMs / 1000}s)`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(pollMs);
    try {
      const tx = await client.getTransaction({ hash: txHash });
      const historyChanges: string[] = tx?.consensus_history?.current_status_changes || [];
      const statusName: string =
        tx?.statusName ||
        tx?.status_name ||
        (historyChanges.includes('FINALIZED')
          ? 'FINALIZED'
          : historyChanges[historyChanges.length - 1] || 'PENDING');
      const resultName: string = tx?.result_name || tx?.resultName || 'UNKNOWN';
      const lr = tx?.consensus_data?.leader_receipt?.[0];
      const execResult: string = lr?.execution_result || 'PENDING';
      const returnPayload = lr?.result?.payload?.readable ?? lr?.result?.payload ?? '';
      const triggered: string[] = Array.isArray(tx?.triggered_transactions) ? tx.triggered_transactions : [];
      const stderr: string = lr?.genvm_result?.stderr || '';

      console.log(
        `    [${attempt}/${maxAttempts}] status=${statusName} consensus=${resultName} exec=${execResult} children=${triggered.length}`
      );

      if (statusName === 'FINALIZED' || statusName === 'UNDETERMINED' || statusName === 'CANCELED') {
        const contractAddress = tx?.to_address || tx?.contract_address || tx?.data?.contract_address;
        if ((execResult === 'ERROR' || statusName !== 'FINALIZED') && !allowError) {
          throw new Error(
            `Tx ${txHash} ended with status=${statusName} exec=${execResult} consensus=${resultName}: ${stderr || JSON.stringify(returnPayload)}`
          );
        }
        return {
          txHash,
          statusName,
          resultName,
          executionResult: execResult,
          returnReadable: returnPayload,
          contractAddress,
          triggeredTransactions: triggered,
          rawTx: tx,
          stderr,
        };
      }
    } catch (err: any) {
      if (err?.message?.includes('ended with status=')) {
        throw err;
      }
      console.warn(`    [Poll warning ${attempt}]: ${String(err?.message || err).slice(0, 180)}`);
    }
  }
  throw new Error(`Tx ${txHash} did not reach FINALIZED within ${(maxAttempts * pollMs) / 1000}s`);
}

/**
 * Waits for parent transaction AND recursively waits for all triggered finality callback child transactions.
 */
export async function waitForFinalizedTree(
  client: any,
  txHash: string,
  options: { maxAttempts?: number; pollMs?: number; allowError?: boolean } = {}
): Promise<{ parent: FinalizedReceipt; children: FinalizedReceipt[] }> {
  const parent = await waitForFinalized(client, txHash, options);
  const children: FinalizedReceipt[] = [];
  const queue = [...parent.triggeredTransactions];
  const seen = new Set<string>([txHash.toLowerCase()]);

  while (queue.length > 0) {
    const childHash = queue.shift()!;
    if (!childHash || seen.has(childHash.toLowerCase())) continue;
    seen.add(childHash.toLowerCase());
    console.log(`  [CALLBACK] Following emitted finality child tx: ${childHash}`);
    const childReceipt = await waitForFinalized(client, childHash, options);
    children.push(childReceipt);
    for (const grand of childReceipt.triggeredTransactions) {
      if (grand && !seen.has(grand.toLowerCase())) {
        queue.push(grand);
      }
    }
  }
  return { parent, children };
}
