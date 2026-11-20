# GenLayer Portal Submission Fields — Verity

> Ready for human review and manual submission to the GenLayer Portal.

---

## Contribution Type
`Projects / deployed contract` *(with separate Tutorial eligibility via `docs/TUTORIAL.md`)*

## One-Liner
Verity is a Risk-Limiting Sequential Citation Audit Protocol on GenLayer combining Wald's SPRT, commit-reveal unbiased sampling, and verbatim-quote validator consensus.

## Description (841 / 1,000 characters)
Verity brings Risk-Limiting Statistical Audits (Abraham Wald's Sequential Probability Ratio Test) to GenLayer to verify batch factual citation grounding without checking 100% of a corpus on-chain or allowing single-entry cherry-picking. Deterministic code (VerityAuditVault) freezes corpus manifests, enforces an immutable URL allowlist (IETF RFCs, Wikipedia revids, pinned GitHub SHAs, Archive.org id_), runs SHA-256 commit-reveal Fisher-Yates sampling, executes scaled-integer SPRT early stopping, and settles GEN strictly via finality callbacks. Stateless GenLayer validators (VerityCitationJudge) run narrow one-claim-per-tx checks, independently verifying slice_sha256 and verbatim quotes in their own fetched bytes while neutralizing prompt-injection payloads. Verified live across 72 finalized StudioNet transactions and 100% byte-identical on-chain source.

## How-To Steps for Reviewers
1. Open **https://verity-rla.vercel.app** (no wallet required) — defaults to **Recorded proof (`deploy/proof.json`)** on StudioNet (Chain 61999).
2. Inspect **Corpus 2 (`Certified sound`)**: view the interactive **Wald SPRT Trajectory** crossing the green Certify Bound in **4 of 10 samples (60% validator work saved)**; click any node or row in the Citation Index to inspect the verified verbatim RFC quote, `slice_sha256`, and immutable source link.
3. Switch to **Corpus 3 (`Rejected defective`)**: verify Sample 1 (hallucinated RFC 8259 UTF-16 claim) stayed in `CONTINUE` while Sample 2 (real third-party `Open-Prompt-Injection/IgnoreAttacker.py`) neutralized `"Ignore previous instructions"` as `UNSUPPORTED`, crossed the red Reject Bound, and slashed the publisher's bond.
4. Switch to **Corpus 1 (`Rejected vague rule`)**, **Corpus 4 (`Open for audit` after anti-grief expiration & `REVEAL_DEADLINE_PASSED`)**, and **Corpus 5 (`Expired refunded` after live Wikipedia `revids=333954216` verification, `AUDIT_DEADLINE_PASSED`, and live `expire_stalled_audit` grace fallback)** to confirm every failure and recovery mode.
5. Open **Finalized ledger** in the left rail to inspect all 72 finalized transactions (including emitted `emit(on="finalized")` callbacks and Type 0 EOA value transfers), click **Live RPC** to confirm `Vault conservation: Exact`, or run `npm run verify:proof` locally to verify live `gen_getContractCode` source equality and all 72 receipts.
6. *(Optional)* Open **Wallet workbench** and connect MetaMask on GenLayer StudioNet (`chainId: 61999`) to publish a corpus or challenge open Corpus 4 live.

## Expected Outcome
- `npm run verify:proof` confirms **100% byte-identical live on-chain source** via `gen_getContractCode` for both contracts and verifies **72/72 finalized StudioNet transactions** (2 deploys, 36 parent calls, 26 GenVM finality callbacks, and 8 Type 0 EOA value transfers).
- `VerityAuditVault.get_protocol_info()` reports `conservation_ok = true` (`inbound = 695 wei`, `outbound = 645 wei`, `contract_balance = 50 wei` locked on open Corpus 4), matching live StudioNet EOA balances to the exact wei.
- Corpus 2 certifies early at 4/10 samples (`LLR = -2,351,148`); Corpus 3 rejects and slashes at 2/4 samples including neutralized prompt injection (`LLR = +3,218,876`); Corpus 1 rejects vague rules up front; Case 0 refunds mutable-URL payable deposits; Corpus 5 proves live Wikipedia `revids` verification and `expire_stalled_audit` neutral refund recovery.

## Contract Explorer Links (GenLayer StudioNet — Chain 61999)
- **`VerityAuditVault` (Deterministic Vault & SPRT Engine):** https://explorer-studio.genlayer.com/address/0x470e9e6B51F2C1dB9Bb6db414716622E05BFE6eD
- **`VerityCitationJudge` (Stateless Narrow LLM Oracle):** https://explorer-studio.genlayer.com/address/0x24a968830FDdd1b3476a3E96BB6b3A379E85De1d
- **`EvidenceProbe` (Step 2 Pre-Flight Network Probe):** https://explorer-studio.genlayer.com/address/0xEf1524f83d1BcabF525f360Fbd77Fcd9d99fc18C
- **Public Repository:** https://github.com/khezzed/Verity
- **Live Frontend URL:** https://verity-rla.vercel.app
