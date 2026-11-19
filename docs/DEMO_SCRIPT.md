# Verity — Two-Minute Live Demo Script

**Target Duration:** 2 minutes  
**Audience:** GenLayer Portal Stewards, Builders, and Reviewers  
**Setup:** Open the deployed Verity web app (no wallet required to inspect all finalized StudioNet proofs).

---

## 0:00 – 0:25 | The Problem & Why GenLayer
- **Show:** Top header & KPI bar (`VerityAuditVault` + `VerityCitationJudge` Explorer links, `100% Conserved` invariant, and `Recorded Finalized Proof` vs `Live StudioNet RPC` toggle).
- **Say:** "AI-generated reports and technical briefs are full of hallucinated citations. You can't verify 100 citations on-chain — it's too slow — and checking 1 cherry-picked citation is easy to game. **Verity** brings Wald's Sequential Probability Ratio Test (Risk-Limiting Audits) to GenLayer: plain deterministic code runs commit-reveal sampling and integer SPRT math, while GenLayer LLM validators judge one narrow citation per transaction against immutable third-party specs."

## 0:25 – 0:55 | Case 2: 10-Citation RFC/Wikipedia Brief Certified Early (60% Work Saved)
- **Click:** **Corpus #2 (`CERTIFIED_SOUND`)**.
- **Show:** The **Wald SPRT Trajectory Chart** stepping down across 4 randomized Fisher-Yates draws (`t=1..4`) until $\Lambda_4 = -2.351$ crosses the green Certify Bound ($B = -2.197$).
- **Click:** Any green waypoint node on the chart -> opens the **Corpus Sampling Matrix** evidence drawer.
- **Point out:** Exact `slice_sha256`, immutable IETF RFC link, **verified verbatim quote** checked inside every validator's own copy, and the **6 blue `SKIPPED (EARLY STOP)` cards** proving 60% of validator calls were avoided.

## 0:55 – 1:25 | Case 3: Hallucinated RFC + Real Prompt-Injection Defense (`REJECTED_DEFECTIVE`)
- **Click:** **Corpus #3 (`REJECTED_DEFECTIVE`)**.
- **Show:** The SPRT trajectory jumping upward across two finalized `UNSUPPORTED` samples (`t=1`: hallucinated RFC 8259 UTF-16 claim stays in `CONTINUE`; `t=2`: real third-party `Open-Prompt-Injection/IgnoreAttacker.py` file containing `"Ignore previous instructions"`).
- **Point out:** Validators neutralized the live prompt injection, returned `UNSUPPORTED`, crossed the red Reject Bound ($+2.197$), and slashed the publisher's bond to the auditor via `emit(on="finalized")`.

## 1:25 – 1:45 | Case 1 & Case 4: RuleGate Rejection + Deterministic Fallbacks
- **Click:** **Corpus #1 (`REJECTED_VAGUE`)** -> up-front RuleGate rejected subjective criteria (*"feels innovative"*) and auto-refunded 100% of the publisher's deposit.
- **Click:** **Corpus #4 (`AUDIT_EXPIRED_REFUNDED`)** -> proves anti-grief unrevealed-commit slashing (10% fee + corpus re-open) and stalled-audit grace fallback (zero locked funds).

## 1:45 – 2:00 | Live StudioNet Proof & Interactive Workbench
- **Click:** **"Read Live from StudioNet"** in the top-right to switch from `Recorded Finalized Proof` to a live RPC read on Chain `61999`, scroll briefly past the **Finalized Transaction Ledger** (showing both parent writes and `emit(on="finalized")` callback children), and show the optional **Wallet Workbench** for running new audits end-to-end.
