# GenLayer Portal Submission Fields — Verity

> Ready for human review and manual submission to the GenLayer Portal.

---

## Contribution Type
`Projects / deployed contract` *(with separate Tutorial eligibility via `docs/TUTORIAL.md`)*

## One-Liner
Verity is a Risk-Limiting Sequential Citation Audit Protocol on GenLayer combining Wald's SPRT, commit-reveal unbiased sampling, and verbatim-quote validator consensus.

## Description (797 / 1,000 characters)
Verity brings Risk-Limiting Statistical Audits (Abraham Wald's Sequential Probability Ratio Test) to GenLayer to verify batch factual citation grounding without checking 100% of a corpus on-chain or allowing single-entry cherry-picking. Deterministic code (VerityAuditVault) freezes corpus manifests, enforces an immutable URL allowlist (IETF RFCs, Wikipedia revids, pinned GitHub SHAs, Archive.org id_), runs SHA-256 commit-reveal Fisher-Yates sampling, executes scaled-integer SPRT early stopping, and settles GEN strictly via finality callbacks. Stateless GenLayer validators (VerityCitationJudge) run narrow one-claim-per-tx checks, independently verifying slice_sha256 and verbatim quotes in their own fetched bytes while neutralizing prompt-injection payloads. Verified live across 49 finalized StudioNet transactions.

## How-To Steps for Reviewers
1. Open the deployed Verity web frontend (no wallet required) — defaults to **Recorded Finalized Proof (`deploy/proof.json`)** on StudioNet (Chain 61999).
2. Inspect **Corpus #2 (`CERTIFIED_SOUND`)**: view the interactive **Wald SPRT Trajectory Chart** crossing the green Certify Bound in **4/10 samples (60% validator work saved)**; click any node to inspect the verified verbatim quote, `slice_sha256`, and immutable RFC link.
3. Switch to **Corpus #3 (`REJECTED_DEFECTIVE`)**: verify that Sample #1 (hallucinated RFC 8259 UTF-16 claim) stayed in `CONTINUE` while Sample #2 (real third-party `Open-Prompt-Injection/IgnoreAttacker.py`) neutralized `"Ignore previous instructions"` as `UNSUPPORTED`, crossed the red Reject Bound, and slashed the publisher's bond.
4. Switch to **Corpus #1 (`REJECTED_VAGUE`)** and **Corpus #4 (`OPEN_FOR_AUDIT` after anti-grief expiration & `REVEAL_DEADLINE_PASSED`)** to verify up-front RuleGate rejection, payable safety refunds, and deterministic fallbacks.
5. Click **"Read Live from StudioNet"** to confirm live RPC state matches `conservation_ok = true`, or run `npm run verify:proof` locally to re-verify all 49 finalized transactions and byte-for-byte contract source hashes.
6. *(Optional)* Connect MetaMask on GenLayer StudioNet (`chainId: 61999`) in the Wallet Workbench to submit a corpus or challenge Corpus #4 live.

## Expected Outcome
- All 49 recorded StudioNet transactions (deployments, parent calls, and `emit(on="finalized")` callbacks) verify as `FINALIZED`.
- `VerityAuditVault.get_protocol_info()` reports `conservation_ok = true` (`inbound = 575 wei`, `outbound = 525 wei`, `contract_balance = 50 wei` locked on open Corpus #4).
- Corpus #2 certifies early at 4/10 samples (`LLR = -2,351,148`); Corpus #3 rejects and slashes at 2/4 samples including neutralized prompt injection (`LLR = +3,218,876`); Corpus #1 rejects vague rules up front and refunds 100%; Case 0 refunds mutable-URL payable deposits cleanly.

## Contract Explorer Links (GenLayer StudioNet — Chain 61999)
- **`VerityAuditVault` (Deterministic Vault & SPRT Engine):** https://explorer-studio.genlayer.com/address/0x470e9e6B51F2C1dB9Bb6db414716622E05BFE6eD
- **`VerityCitationJudge` (Stateless Narrow LLM Oracle):** https://explorer-studio.genlayer.com/address/0x24a968830FDdd1b3476a3E96BB6b3A379E85De1d
- **`EvidenceProbe` (Step 2 Pre-Flight Network Probe):** https://explorer-studio.genlayer.com/address/0xEf1524f83d1BcabF525f360Fbd77Fcd9d99fc18C
- **Public Repository:** https://github.com/khezzed/Verity
- **Live Frontend URL:** https://verity-rla.vercel.app
