# Verity Technical Tutorial: Building Risk-Limiting Sequential Citation Audits (Wald SPRT) on GenLayer

> **Prerequisites:** Node.js 20+, Python 3.11+, and access to GenLayer StudioNet (`https://studio.genlayer.com/api`, Chain ID `61999`).

Traditional smart contracts excel at deterministic accounting, but they cannot inspect whether a factual claim in a whitepaper, research brief, or AI-generated bibliography is actually supported by the source it cites. On the other hand, running an LLM consensus call over every single entry in a 50- or 500-citation corpus does not scale, while checking a single cherry-picked citation is gameable in both directions.

**Verity** solves this using **Abraham Wald's Sequential Probability Ratio Test (SPRT)** — the mathematical foundation behind Risk-Limiting Audits — split cleanly across two GenLayer Intelligent Contracts:

1. **`VerityAuditVault` (`contracts/verity_audit_vault.py`)** — 100% deterministic escrow vault, manifest freezer, commit-reveal unbiased sampler, scaled-integer SPRT engine, and timeout fallback controller.
2. **`VerityCitationJudge` (`contracts/verity_citation_judge.py`)** — stateless narrow-judgment GenVM oracle executing up-front RuleGate checks and single-citation semantic verification, returning all verdicts strictly via `emit(on="finalized")`.

---

## Step 1: Separating Judgment from Money Movement

Verity enforces a strict architectural boundary: **the LLM never computes payouts, scores, or sampling indices.** Every non-deterministic call returns one discrete token from a frozen allowlist:

- Up-front RuleGate (`vet_corpus_standard`): `ACCEPTED` or `REJECTED_VAGUE`.
- Atomic Citation Check (`audit_citation_sample`): `SUPPORTED`, `UNSUPPORTED`, or `INSUFFICIENT_EVIDENCE`.

Meanwhile, `VerityAuditVault` holds zero non-deterministic code and enforces a strict financial conservation invariant on every state transition:

```python
lhs = (
    int(self.total_publisher_bonds)
    + int(self.total_auditor_stakes)
    + int(self.total_claimable)
    + int(self.total_refundable)
)
rhs = int(self.total_inbound_wei) - int(self.total_outbound_wei)
assert lhs == rhs
```

Because a failed payable call on StudioNet can credit value even when state rolls back, `submit_corpus` and `commit_audit` capture invalid-input payable deposits inside `refundable_balances` instead of reverting and stranding wei. Withdrawals to Externally Owned Accounts (EOAs) use GenLayer's `@gl.evm.contract_interface` (`_EvmRecipient(sender).emit_transfer(value=amount)`), which settles on finality.

---

## Step 2: Enforcing Immutable Evidence & Verbatim-Quote Consensus

Live webpages mutate between validator fetches, breaking consensus. Both contracts enforce a strict immutable URL allowlist accepting only:

- **IETF RFC Editor** plain-text specifications (`https://www.rfc-editor.org/rfc/rfc<N>.txt`)
- **Wikipedia Permanent Revisions** via the MediaWiki JSON API (`?revids=<id>`)
- **GitHub Raw Content** pinned to an exact 40-lowercase-hex commit SHA
- **Archive.org Raw Snapshots** using the toolbar-free `id_` timestamp form

Before the LLM ever sees fetched bytes, `extract_bounded_slice` unwraps any MediaWiki JSON envelope in plain Python, locates the entry's `anchor_hint`, extracts a deterministic window of at most `2,200` characters, and computes `slice_sha256`.

Inside `VerityCitationJudge.audit_citation_sample`:
1. The leader wraps the bounded slice inside `<UNTRUSTED_SOURCE_EXCERPT>...</UNTRUSTED_SOURCE_EXCERPT>` with explicit anti-prompt-injection instructions and returns `{fetch_status, slice_sha256, verdict, verbatim_quote}`.
2. Each validator **independently fetches the URL**, recomputes `val_slice_sha256`, verifies exact digest equality, checks that `verbatim_quote` (16–280 chars, whitespace-normalized for RFC column-72 line wraps) **literally exists in its own copy**, and compares its independent discrete verdict.
3. Only after consensus passes GenLayer's native appeal window does `VerityCitationJudge` emit `vault.emit(on="finalized").on_sample_judged(...)`.

---

## Step 3: Commit-Reveal Fisher-Yates Sampling & Scaled-Integer Wald SPRT

To stop either the publisher or the auditor from cherry-picking entries:
1. The publisher freezes `manifest_sha256` before any audit starts.
2. The auditor stakes GEN and commits `sha256(salt_preimage)` before knowing `commit_ts`.
3. Upon `reveal_audit_seed`, `VerityAuditVault` computes `seed = sha256(manifest_sha256 | salt_preimage | commit_ts | audit_id)` and runs a deterministic SHA-256 counter-mode Fisher-Yates shuffle over `[0..N-1]`.

Each finalized sample updates the scaled-integer log-likelihood ratio ($\text{scale} = 10^6$, zero floats). Under the `STANDARD_90` profile ($p_0 = 10\%, p_1 = 50\%, \alpha = \beta = 10\%$):

- `SUPPORTED`: $\Delta_{\text{pass}} = -587{,}787$
- `UNSUPPORTED` or `HTTP_NOT_FOUND`: $\Delta_{\text{fail}} = +1{,}609{,}438$
- Early-Stop Certify Bound: $B = -2{,}197{,}225$ (reached in **4 clean passes**, saving 60% of validator work on a 10-entry corpus!)
- Early-Stop Reject Bound: $A = +2{,}197{,}225$ (reached in **2 defects**, while 1 isolated error remains in the `CONTINUE` band so honest corpora are not unfairly slashed!)

---

## Step 4: Running Tests, Deploying, and Verifying Live Proofs

1. **Lint and run direct-mode contract tests:**
   ```bash
   .venv/Scripts/genvm-lint check contracts/verity_citation_judge.py
   .venv/Scripts/genvm-lint check contracts/verity_audit_vault.py
   npm run test:direct
   ```
2. **Run the pre-flight StudioNet evidence probe:**
   ```bash
   npm run probe:studionet
   ```
3. **Deploy contracts and execute all live demo cases to finality:**
   ```bash
   npm run deploy:studionet
   ```
4. **Independently re-verify every finalized transaction and source hash (read-only):**
   ```bash
   npm run verify:proof
   ```

Every finalized transaction hash, `slice_sha256`, verbatim quote, and live SPRT trajectory can then be inspected without a wallet in the deployed frontend, or exercised interactively by connecting a MetaMask wallet on StudioNet (Chain ID `61999`).
