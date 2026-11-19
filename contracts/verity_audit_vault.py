# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from datetime import datetime
import hashlib
import json
import re
from typing import Any
from genlayer import *

# =============================================================================
# Protocol Constants & Scaled Fixed-Point Wald SPRT Profiles (Zero Floats)
# =============================================================================

MAX_U256 = (1 << 256) - 1
SPRT_SCALE = 1_000_000

SPRT_PROFILES: dict[str, dict[str, int]] = {
    # p0=10%, p1=50%, alpha=10%, beta=10%: 4 clean passes certify; 2 defects reject
    "STANDARD_90": {
        "p0_bps": 1000,
        "p1_bps": 5000,
        "alpha_bps": 1000,
        "beta_bps": 1000,
        "delta_pass": -587787,
        "delta_fail": 1609438,
        "bound_certify": -2197225,
        "bound_reject": 2197225,
        "min_entries": 4,
    },
    # p0=10%, p1=45%, alpha=5%, beta=5%: 6 clean passes certify; 2 defects reject
    "HIGH_ASSURANCE_95": {
        "p0_bps": 1000,
        "p1_bps": 4500,
        "alpha_bps": 500,
        "beta_bps": 500,
        "delta_pass": -492476,
        "delta_fail": 1504077,
        "bound_certify": -2944439,
        "bound_reject": 2944439,
        "min_entries": 6,
    },
    # p0=5%, p1=35%, alpha=5%, beta=5%: 8 clean passes certify; 2 defects reject
    "STRICT_95": {
        "p0_bps": 500,
        "p1_bps": 3500,
        "alpha_bps": 500,
        "beta_bps": 500,
        "delta_pass": -379490,
        "delta_fail": 1945910,
        "bound_certify": -2944439,
        "bound_reject": 2944439,
        "min_entries": 8,
    },
}

MAX_CORPORA = 128
MAX_AUDITS = 256
MAX_ENTRIES_PER_CORPUS = 32
MAX_TITLE_LEN = 120
MAX_RULE_LEN = 480
MAX_CLAIM_LEN = 360
MAX_URL_LEN = 420
MAX_ANCHOR_LEN = 100
MAX_MANIFEST_JSON_LEN = 24000
MIN_BOND_WEI = 2
MIN_DURATION_SEC = 15
MAX_DURATION_SEC = 30 * 86400
DEFAULT_VETTING_TIMEOUT_SEC = 900
DEFAULT_GRACE_PERIOD_SEC = 30
MAX_TRANSIENT_RETRIES_PER_SAMPLE = 1

CORPUS_PENDING_VETTING = "PENDING_VETTING"
CORPUS_REJECTED_VAGUE = "REJECTED_VAGUE"
CORPUS_VETTING_EXPIRED = "VETTING_EXPIRED"
CORPUS_OPEN_FOR_AUDIT = "OPEN_FOR_AUDIT"
CORPUS_UNDER_AUDIT = "UNDER_AUDIT"
CORPUS_CERTIFIED_SOUND = "CERTIFIED_SOUND"
CORPUS_REJECTED_DEFECTIVE = "REJECTED_DEFECTIVE"
CORPUS_CLOSED_UNCHALLENGED = "CLOSED_UNCHALLENGED"
CORPUS_AUDIT_EXPIRED_REFUNDED = "AUDIT_EXPIRED_REFUNDED"

AUDIT_COMMITTED = "COMMITTED"
AUDIT_ACTIVE = "ACTIVE"
AUDIT_SAMPLE_IN_FLIGHT = "SAMPLE_IN_FLIGHT"
AUDIT_EXPIRED_UNREVEALED = "EXPIRED_UNREVEALED"
AUDIT_SETTLED_CERTIFIED = "SETTLED_CERTIFIED"
AUDIT_SETTLED_REJECTED = "SETTLED_REJECTED"
AUDIT_SETTLED_EXPIRED_REFUNDED = "SETTLED_EXPIRED_REFUNDED"

_HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
_RFC_URL_RE = re.compile(r"^https://www\.rfc-editor\.org/rfc/rfc[0-9]{1,5}\.txt$")
_WIKI_REVID_URL_RE = re.compile(
    r"^https://en\.wikipedia\.org/w/api\.php\?action=query&prop=revisions&rvprop=content&format=json&formatversion=2&revids=[0-9]{1,12}$"
)
_GITHUB_PINNED_URL_RE = re.compile(
    r"^https://raw\.githubusercontent\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/([0-9a-f]{40})/([A-Za-z0-9_./-]+)$"
)
_ARCHIVE_ID_URL_RE = re.compile(
    r"^https://web\.archive\.org/web/[0-9]{14}id_/https?://[A-Za-z0-9._~:/@!$&'()*+,;=-]+$"
)


# =============================================================================
# Verified EVM / EOA Finality Transfer Interface
# =============================================================================

@gl.evm.contract_interface
class _EvmRecipient:
    """Verified EVM/EOA transfer interface emitting external finality transfer on GenLayer."""

    class View:
        pass

    class Write:
        pass


# =============================================================================
# Pure Deterministic Helpers (Zero `self` References)
# =============================================================================

def _to_address(addr: Any) -> Address:
    if isinstance(addr, Address):
        return addr
    s = str(addr).strip()
    if not re.match(r"^0x[0-9a-fA-F]{40}$", s):
        raise gl.vm.UserError("INVALID_ADDRESS")
    return Address(s)


def _safe_add_u256(a: int | u256, b: int | u256) -> u256:
    va = int(a)
    vb = int(b)
    if va < 0 or vb < 0 or (va + vb) > MAX_U256:
        raise gl.vm.UserError("U256_OVERFLOW")
    return u256(va + vb)


def _safe_sub_u256(a: int | u256, b: int | u256) -> u256:
    va = int(a)
    vb = int(b)
    if va < vb or vb < 0:
        raise gl.vm.UserError("U256_UNDERFLOW")
    return u256(va - vb)


def _current_timestamp() -> int:
    raw = getattr(gl, "message_raw", None)
    if raw and isinstance(raw, dict) and raw.get("datetime") is not None:
        dt_raw = raw["datetime"]
        if isinstance(dt_raw, (int, float)):
            return int(dt_raw)
        dt_str = str(dt_raw).replace("Z", "+00:00")
        return int(datetime.fromisoformat(dt_str).timestamp())
    msg = getattr(gl, "message", None)
    if msg is not None and hasattr(msg, "timestamp") and msg.timestamp is not None:
        return int(msg.timestamp)
    raise gl.vm.UserError("NO_BLOCK_TIME")


def is_immutable_source_url(url: str) -> bool:
    if not isinstance(url, str) or not (1 <= len(url) <= MAX_URL_LEN):
        return False
    if any(ch in url for ch in (" ", "\t", "\n", "\r", "#", "..")):
        return False
    if _RFC_URL_RE.match(url):
        return True
    if _WIKI_REVID_URL_RE.match(url):
        return True
    m_gh = _GITHUB_PINNED_URL_RE.match(url)
    if m_gh:
        if "?" in url or "%" in url:
            return False
        path_part = m_gh.group(4)
        if not path_part or path_part.startswith("/") or path_part.endswith("/") or "//" in path_part:
            return False
        return True
    if _ARCHIVE_ID_URL_RE.match(url):
        return True
    return False


def parse_and_validate_manifest(
    entries_json: str,
    profile_id: str,
) -> tuple[list[dict[str, str]] | None, str]:
    if profile_id not in SPRT_PROFILES:
        return None, "INVALID_PROFILE"
    if not isinstance(entries_json, str) or not (2 <= len(entries_json) <= MAX_MANIFEST_JSON_LEN):
        return None, "INVALID_MANIFEST_SIZE"
    try:
        raw_entries = json.loads(entries_json)
    except Exception:
        return None, "INVALID_MANIFEST_JSON"
    if not isinstance(raw_entries, list):
        return None, "MANIFEST_NOT_LIST"

    min_entries = SPRT_PROFILES[profile_id]["min_entries"]
    if not (min_entries <= len(raw_entries) <= MAX_ENTRIES_PER_CORPUS):
        return None, "INVALID_ENTRY_COUNT"

    canonical: list[dict[str, str]] = []
    for idx, item in enumerate(raw_entries):
        if not isinstance(item, dict):
            return None, f"ENTRY_NOT_OBJECT_{idx}"
        claim = " ".join(str(item.get("claim", "")).strip().split())
        source_url = str(item.get("source_url", "")).strip()
        anchor = " ".join(str(item.get("anchor", "")).strip().split())
        if not (10 <= len(claim) <= MAX_CLAIM_LEN):
            return None, f"INVALID_CLAIM_{idx}"
        if not is_immutable_source_url(source_url):
            return None, f"NON_IMMUTABLE_URL_{idx}"
        if len(anchor) > MAX_ANCHOR_LEN:
            return None, f"INVALID_ANCHOR_{idx}"
        canonical.append(
            {
                "claim": claim,
                "source_url": source_url,
                "anchor": anchor,
            }
        )
    return canonical, ""


def compute_manifest_sha256(
    domain_title: str,
    grounding_rule: str,
    profile_id: str,
    entries: list[dict[str, str]],
) -> str:
    payload = {
        "domain_title": domain_title,
        "grounding_rule": grounding_rule,
        "profile_id": profile_id,
        "entries": entries,
    }
    canon = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


def deterministic_fisher_yates_order(seed_hex: str, n: int) -> list[int]:
    """
    Deterministic SHA-256 counter-mode Fisher-Yates permutation without replacement.
    Identical across every Python build, platform, and GenVM WASM instance.
    """
    arr = list(range(n))
    for i in range(n - 1, 0, -1):
        h = hashlib.sha256(f"{seed_hex}:{i}".encode("utf-8")).digest()
        j = int.from_bytes(h[:8], "big") % (i + 1)
        arr[i], arr[j] = arr[j], arr[i]
    return arr


def apply_sprt_step(
    current_llr: int,
    verdict: str,
    fetch_status: str,
    profile: dict[str, int],
    samples_counted: int,
    total_entries: int,
) -> tuple[int, int, str]:
    """
    Pure integer Wald SPRT transition (scaled by 1,000,000, zero floats).
    Returns: (new_llr, delta_applied, decision)
      decision in {"CERTIFIED_SOUND", "REJECTED_DEFECTIVE", "CERTIFIED_TRUNCATED", "REJECTED_TRUNCATED", "CONTINUE"}
    """
    if verdict == "SUPPORTED" and fetch_status == "OK":
        delta = profile["delta_pass"]
        counted = samples_counted + 1
    elif verdict == "UNSUPPORTED" or fetch_status in ("HTTP_NOT_FOUND", "INVALID_URL"):
        delta = profile["delta_fail"]
        counted = samples_counted + 1
    else:
        # INSUFFICIENT_EVIDENCE / transient fetch error: neutral delta
        delta = 0
        counted = samples_counted

    new_llr = current_llr + delta
    if new_llr <= profile["bound_certify"]:
        return new_llr, delta, "CERTIFIED_SOUND"
    if new_llr >= profile["bound_reject"]:
        return new_llr, delta, "REJECTED_DEFECTIVE"
    if counted >= total_entries:
        if new_llr <= 0:
            return new_llr, delta, "CERTIFIED_TRUNCATED"
        return new_llr, delta, "REJECTED_TRUNCATED"
    return new_llr, delta, "CONTINUE"


# =============================================================================
# Deterministic Vault, Commit-Reveal Sampler & Integer Wald SPRT Contract
# =============================================================================

class VerityAuditVault(gl.Contract):
    """
    VerityAuditVault: 100% deterministic escrow vault, corpus manifest freezer,
    commit-reveal Fisher-Yates sampler, and scaled-integer Wald SPRT settler.

    Zero non-deterministic calls live here. All LLM semantic judgments execute in
    VerityCitationJudge and arrive strictly via emit(on='finalized') callbacks.
    All EOA payouts execute via _EvmRecipient(addr).emit_transfer (on finality).
    """

    judge_address: Address
    corpus_counter: u256
    audit_counter: u256

    corpora: TreeMap[u256, str]
    audits: TreeMap[u256, str]
    claimable_balances: TreeMap[Address, u256]
    refundable_balances: TreeMap[Address, u256]

    # Strict Conservation Invariant Accounting Buckets
    total_inbound_wei: u256
    total_outbound_wei: u256
    total_publisher_bonds: u256
    total_auditor_stakes: u256
    total_claimable: u256
    total_refundable: u256

    def __init__(self, judge_addr: str):
        target = _to_address(judge_addr)
        if target == _to_address("0x0000000000000000000000000000000000000000"):
            raise gl.vm.UserError("ZERO_JUDGE_ADDRESS")
        self.judge_address = target
        self.corpus_counter = u256(0)
        self.audit_counter = u256(0)
        self.total_inbound_wei = u256(0)
        self.total_outbound_wei = u256(0)
        self.total_publisher_bonds = u256(0)
        self.total_auditor_stakes = u256(0)
        self.total_claimable = u256(0)
        self.total_refundable = u256(0)

    # -------------------------------------------------------------------------
    # Internal Accounting & Invariant Helpers
    # -------------------------------------------------------------------------

    def _assert_non_payable(self) -> None:
        if int(gl.message.value) != 0:
            raise gl.vm.UserError("NON_PAYABLE_METHOD")

    def _assert_judge_caller(self) -> None:
        if _to_address(gl.message.sender_address) != self.judge_address:
            raise gl.vm.UserError("ONLY_JUDGE")

    def _assert_conservation(self) -> None:
        lhs = (
            int(self.total_publisher_bonds)
            + int(self.total_auditor_stakes)
            + int(self.total_claimable)
            + int(self.total_refundable)
        )
        rhs = int(self.total_inbound_wei) - int(self.total_outbound_wei)
        if lhs != rhs:
            raise gl.vm.UserError("CONSERVATION_INVARIANT_VIOLATION")

    def _credit_claimable(self, recipient: Address, amount: u256) -> None:
        if int(amount) == 0:
            return
        cur = self.claimable_balances.get(recipient, u256(0))
        self.claimable_balances[recipient] = _safe_add_u256(cur, amount)
        self.total_claimable = _safe_add_u256(self.total_claimable, amount)

    def _credit_refundable(self, recipient: Address, amount: u256) -> None:
        if int(amount) == 0:
            return
        cur = self.refundable_balances.get(recipient, u256(0))
        self.refundable_balances[recipient] = _safe_add_u256(cur, amount)
        self.total_refundable = _safe_add_u256(self.total_refundable, amount)

    def _refund_invalid_payable(self, sender: Address, value: u256, code: str) -> str:
        """
        StudioNet payable safety: if a payable call fails validation after sending value,
        credit refundable_balances instead of raising a revert that could strand wei.
        """
        if int(value) > 0:
            self.total_inbound_wei = _safe_add_u256(self.total_inbound_wei, value)
            self._credit_refundable(sender, value)
            self._assert_conservation()
            return f"REFUNDED_ERROR:{code}"
        raise gl.vm.UserError(code)

    def _load_corpus(self, corpus_id: u256) -> dict[str, Any]:
        cid = u256(int(corpus_id))
        if cid not in self.corpora:
            raise gl.vm.UserError("CORPUS_NOT_FOUND")
        return json.loads(self.corpora[cid])

    def _save_corpus(self, corpus_id: u256, obj: dict[str, Any]) -> None:
        self.corpora[u256(int(corpus_id))] = json.dumps(obj, sort_keys=True, separators=(",", ":"))

    def _load_audit(self, audit_id: u256) -> dict[str, Any]:
        aid = u256(int(audit_id))
        if aid not in self.audits:
            raise gl.vm.UserError("AUDIT_NOT_FOUND")
        return json.loads(self.audits[aid])

    def _save_audit(self, audit_id: u256, obj: dict[str, Any]) -> None:
        self.audits[u256(int(audit_id))] = json.dumps(obj, sort_keys=True, separators=(",", ":"))

    # -------------------------------------------------------------------------
    # Stage 1: Publisher Submits Corpus + Veracity Bond -> RuleGate Vetting
    # -------------------------------------------------------------------------

    @gl.public.write.payable
    def submit_corpus(
        self,
        domain_title: str,
        grounding_rule: str,
        profile_id: str,
        entries_json: str,
        challenge_duration_sec: u256,
        reveal_window_sec: u256,
        audit_duration_sec: u256,
    ) -> str:
        sender = _to_address(gl.message.sender_address)
        val = u256(int(gl.message.value))
        now = _current_timestamp()

        if int(self.corpus_counter) >= MAX_CORPORA:
            return self._refund_invalid_payable(sender, val, "MAX_CORPORA_REACHED")
        if int(val) < MIN_BOND_WEI:
            return self._refund_invalid_payable(sender, val, "BOND_BELOW_MINIMUM")

        title = " ".join(str(domain_title).strip().split())
        rule = " ".join(str(grounding_rule).strip().split())
        prof = str(profile_id).strip().upper()
        if not (4 <= len(title) <= MAX_TITLE_LEN):
            return self._refund_invalid_payable(sender, val, "INVALID_TITLE")
        if not (12 <= len(rule) <= MAX_RULE_LEN):
            return self._refund_invalid_payable(sender, val, "INVALID_GROUNDING_RULE")

        c_dur = int(challenge_duration_sec)
        r_dur = int(reveal_window_sec)
        a_dur = int(audit_duration_sec)
        if not (MIN_DURATION_SEC <= c_dur <= MAX_DURATION_SEC):
            return self._refund_invalid_payable(sender, val, "INVALID_CHALLENGE_DURATION")
        if not (MIN_DURATION_SEC <= r_dur <= MAX_DURATION_SEC):
            return self._refund_invalid_payable(sender, val, "INVALID_REVEAL_WINDOW")
        if not (MIN_DURATION_SEC <= a_dur <= MAX_DURATION_SEC):
            return self._refund_invalid_payable(sender, val, "INVALID_AUDIT_DURATION")

        entries, err = parse_and_validate_manifest(entries_json, prof)
        if entries is None:
            return self._refund_invalid_payable(sender, val, err)

        manifest_hash = compute_manifest_sha256(title, rule, prof, entries)
        new_id = _safe_add_u256(self.corpus_counter, u256(1))
        self.corpus_counter = new_id

        self.total_inbound_wei = _safe_add_u256(self.total_inbound_wei, val)
        self.total_publisher_bonds = _safe_add_u256(self.total_publisher_bonds, val)
        self._assert_conservation()

        corpus_obj = {
            "corpus_id": int(new_id),
            "publisher": str(sender),
            "domain_title": title,
            "grounding_rule": rule,
            "profile_id": prof,
            "entries": entries,
            "entry_count": len(entries),
            "manifest_sha256": manifest_hash,
            "bond_wei": int(val),
            "min_audit_stake_wei": max(1, int(val) // 2),
            "status": CORPUS_PENDING_VETTING,
            "vetting_reason": "",
            "created_at": now,
            "vetting_deadline": now + DEFAULT_VETTING_TIMEOUT_SEC,
            "challenge_duration_sec": c_dur,
            "reveal_window_sec": r_dur,
            "audit_duration_sec": a_dur,
            "challenge_deadline": 0,
            "active_audit_id": 0,
            "audit_ids": [],
        }
        self._save_corpus(new_id, corpus_obj)

        preview_claims = json.dumps([e["claim"] for e in entries[:2]], separators=(",", ":"))
        judge = gl.get_contract_at(self.judge_address)
        judge.emit(on="accepted").vet_corpus_standard(new_id, title, rule, preview_claims)
        return f"SUBMITTED:{int(new_id)}:{manifest_hash}"

    @gl.public.write
    def on_standard_vetted(self, corpus_id: u256, verdict: str, reason_code: str) -> str:
        """
        Finality callback invoked strictly by VerityCitationJudge via emit(on='finalized').
        Opens the corpus if ACCEPTED, or refunds 100% of publisher bond if REJECTED_VAGUE.
        """
        self._assert_non_payable()
        self._assert_judge_caller()
        corpus = self._load_corpus(corpus_id)
        if corpus["status"] != CORPUS_PENDING_VETTING:
            return f"IGNORED_NOT_PENDING:{corpus['status']}"

        now = _current_timestamp()
        v = str(verdict).strip().upper()
        r = str(reason_code).strip().upper()
        corpus["vetting_reason"] = r

        if v == "ACCEPTED":
            corpus["status"] = CORPUS_OPEN_FOR_AUDIT
            corpus["challenge_deadline"] = now + int(corpus["challenge_duration_sec"])
            self._save_corpus(corpus_id, corpus)
            self._assert_conservation()
            return f"CORPUS_OPENED:{int(corpus_id)}"

        # REJECTED_VAGUE -> refund 100% of publisher bond immediately
        bond = u256(int(corpus["bond_wei"]))
        pub = _to_address(corpus["publisher"])
        corpus["status"] = CORPUS_REJECTED_VAGUE
        corpus["bond_wei"] = 0
        self._save_corpus(corpus_id, corpus)

        self.total_publisher_bonds = _safe_sub_u256(self.total_publisher_bonds, bond)
        self._credit_refundable(pub, bond)
        self._assert_conservation()
        return f"CORPUS_REJECTED_VAGUE:{int(corpus_id)}:{r}"

    @gl.public.write
    def reclaim_stalled_vetting(self, corpus_id: u256) -> str:
        """Deterministic fallback if RuleGate never finalizes past vetting_deadline."""
        self._assert_non_payable()
        corpus = self._load_corpus(corpus_id)
        if corpus["status"] != CORPUS_PENDING_VETTING:
            raise gl.vm.UserError("CORPUS_NOT_PENDING_VETTING")
        now = _current_timestamp()
        if now <= int(corpus["vetting_deadline"]):
            raise gl.vm.UserError("VETTING_DEADLINE_NOT_REACHED")

        bond = u256(int(corpus["bond_wei"]))
        pub = _to_address(corpus["publisher"])
        corpus["status"] = CORPUS_VETTING_EXPIRED
        corpus["bond_wei"] = 0
        self._save_corpus(corpus_id, corpus)

        self.total_publisher_bonds = _safe_sub_u256(self.total_publisher_bonds, bond)
        self._credit_refundable(pub, bond)
        self._assert_conservation()
        return f"VETTING_EXPIRED_REFUNDED:{int(corpus_id)}"

    @gl.public.write
    def close_unchallenged_corpus(self, corpus_id: u256) -> str:
        """Deterministic fallback returning publisher bond if challenge_deadline elapses unchallenged."""
        self._assert_non_payable()
        corpus = self._load_corpus(corpus_id)
        if corpus["status"] != CORPUS_OPEN_FOR_AUDIT:
            raise gl.vm.UserError("CORPUS_NOT_OPEN")
        now = _current_timestamp()
        if now <= int(corpus["challenge_deadline"]):
            raise gl.vm.UserError("CHALLENGE_WINDOW_ACTIVE")

        bond = u256(int(corpus["bond_wei"]))
        pub = _to_address(corpus["publisher"])
        corpus["status"] = CORPUS_CLOSED_UNCHALLENGED
        corpus["bond_wei"] = 0
        self._save_corpus(corpus_id, corpus)

        self.total_publisher_bonds = _safe_sub_u256(self.total_publisher_bonds, bond)
        self._credit_claimable(pub, bond)
        self._assert_conservation()
        return f"CLOSED_UNCHALLENGED:{int(corpus_id)}"

    # -------------------------------------------------------------------------
    # Stage 2: Commit-Reveal Unbiased Sampling (Prevents Cherry-Picking)
    # -------------------------------------------------------------------------

    @gl.public.write.payable
    def commit_audit(self, corpus_id: u256, salt_commit_hash: str) -> str:
        """
        Auditor stakes challenge GEN and commits sha256(salt_preimage) to begin a
        Risk-Limiting Sequential Audit without knowing commit_ts ahead of time.
        """
        sender = _to_address(gl.message.sender_address)
        val = u256(int(gl.message.value))
        now = _current_timestamp()

        if int(self.audit_counter) >= MAX_AUDITS:
            return self._refund_invalid_payable(sender, val, "MAX_AUDITS_REACHED")
        cid = u256(int(corpus_id))
        if cid not in self.corpora:
            return self._refund_invalid_payable(sender, val, "CORPUS_NOT_FOUND")

        corpus = self._load_corpus(cid)
        if corpus["status"] != CORPUS_OPEN_FOR_AUDIT:
            return self._refund_invalid_payable(sender, val, "CORPUS_NOT_OPEN_FOR_AUDIT")
        if now > int(corpus["challenge_deadline"]):
            return self._refund_invalid_payable(sender, val, "CHALLENGE_WINDOW_EXPIRED")
        if int(val) < int(corpus["min_audit_stake_wei"]):
            return self._refund_invalid_payable(sender, val, "INSUFFICIENT_AUDIT_STAKE")

        commit_hex = str(salt_commit_hash).strip().lower()
        if not _HEX64_RE.match(commit_hex):
            return self._refund_invalid_payable(sender, val, "INVALID_COMMIT_HASH")

        new_aid = _safe_add_u256(self.audit_counter, u256(1))
        self.audit_counter = new_aid

        self.total_inbound_wei = _safe_add_u256(self.total_inbound_wei, val)
        self.total_auditor_stakes = _safe_add_u256(self.total_auditor_stakes, val)
        self._assert_conservation()

        prof = SPRT_PROFILES[corpus["profile_id"]]
        audit_obj = {
            "audit_id": int(new_aid),
            "corpus_id": int(cid),
            "auditor": str(sender),
            "stake_wei": int(val),
            "salt_commit_hash": commit_hex,
            "salt_preimage": "",
            "seed_hex": "",
            "commit_ts": now,
            "reveal_deadline": now + int(corpus["reveal_window_sec"]),
            "audit_deadline": 0,
            "grace_deadline": 0,
            "status": AUDIT_COMMITTED,
            "profile_id": corpus["profile_id"],
            "llr_scaled": 0,
            "bound_certify": prof["bound_certify"],
            "bound_reject": prof["bound_reject"],
            "delta_pass": prof["delta_pass"],
            "delta_fail": prof["delta_fail"],
            "sample_order": [],
            "next_cursor": 0,
            "samples_counted": 0,
            "in_flight_seq": 0,
            "in_flight_entry_idx": -1,
            "in_flight_retries": 0,
            "samples": [],
            "terminal_decision": "",
            "settled_at": 0,
        }
        self._save_audit(new_aid, audit_obj)

        corpus["status"] = CORPUS_UNDER_AUDIT
        corpus["active_audit_id"] = int(new_aid)
        corpus["audit_ids"].append(int(new_aid))
        self._save_corpus(cid, corpus)
        self._assert_conservation()
        return f"AUDIT_COMMITTED:{int(new_aid)}"

    @gl.public.write
    def reveal_audit_seed(self, audit_id: u256, salt_preimage: str) -> str:
        """
        Auditor reveals salt_preimage before reveal_deadline. Contract verifies
        sha256(salt_preimage) == salt_commit_hash and derives an unbiased Fisher-Yates
        sample_order over [0..N-1].
        """
        self._assert_non_payable()
        sender = _to_address(gl.message.sender_address)
        audit = self._load_audit(audit_id)
        if audit["status"] != AUDIT_COMMITTED:
            raise gl.vm.UserError("AUDIT_NOT_COMMITTED")
        if sender != _to_address(audit["auditor"]):
            raise gl.vm.UserError("ONLY_AUDITOR")

        now = _current_timestamp()
        if now > int(audit["reveal_deadline"]):
            raise gl.vm.UserError("REVEAL_DEADLINE_PASSED")

        preimage = str(salt_preimage)
        if not (1 <= len(preimage) <= 128):
            raise gl.vm.UserError("INVALID_PREIMAGE")
        computed = hashlib.sha256(preimage.encode("utf-8")).hexdigest()
        if computed != audit["salt_commit_hash"]:
            raise gl.vm.UserError("COMMIT_HASH_MISMATCH")

        corpus = self._load_corpus(u256(int(audit["corpus_id"])))
        seed_input = f"{corpus['manifest_sha256']}|{preimage}|{audit['commit_ts']}|{audit['audit_id']}"
        seed_hex = hashlib.sha256(seed_input.encode("utf-8")).hexdigest()
        order = deterministic_fisher_yates_order(seed_hex, int(corpus["entry_count"]))

        audit["salt_preimage"] = preimage
        audit["seed_hex"] = seed_hex
        audit["sample_order"] = order
        audit["status"] = AUDIT_ACTIVE
        audit["audit_deadline"] = now + int(corpus["audit_duration_sec"])
        audit["grace_deadline"] = now + int(corpus["audit_duration_sec"]) + DEFAULT_GRACE_PERIOD_SEC
        self._save_audit(audit_id, audit)
        return f"SEED_REVEALED:{int(audit_id)}:{seed_hex[:16]}:{json.dumps(order)}"

    @gl.public.write
    def expire_unrevealed_audit(self, audit_id: u256) -> str:
        """
        Anti-grief deterministic fallback: if auditor fails to reveal before reveal_deadline,
        10% anti-grief fee (min 1 wei when stake >= 2) goes to publisher, 90% refunded to
        auditor, and corpus returns to OPEN_FOR_AUDIT.
        """
        self._assert_non_payable()
        audit = self._load_audit(audit_id)
        if audit["status"] != AUDIT_COMMITTED:
            raise gl.vm.UserError("AUDIT_NOT_COMMITTED")
        now = _current_timestamp()
        if now <= int(audit["reveal_deadline"]):
            raise gl.vm.UserError("REVEAL_WINDOW_ACTIVE")

        cid = u256(int(audit["corpus_id"]))
        corpus = self._load_corpus(cid)
        stake_int = int(audit["stake_wei"])
        penalty_int = max(1, stake_int // 10) if stake_int >= 2 else 0
        refund_int = stake_int - penalty_int

        pub = _to_address(corpus["publisher"])
        aud = _to_address(audit["auditor"])

        audit["status"] = AUDIT_EXPIRED_UNREVEALED
        audit["stake_wei"] = 0
        audit["terminal_decision"] = "EXPIRED_UNREVEALED"
        audit["settled_at"] = now
        self._save_audit(audit_id, audit)

        corpus["status"] = CORPUS_OPEN_FOR_AUDIT
        corpus["active_audit_id"] = 0
        self._save_corpus(cid, corpus)

        self.total_auditor_stakes = _safe_sub_u256(self.total_auditor_stakes, u256(stake_int))
        self._credit_claimable(pub, u256(penalty_int))
        self._credit_refundable(aud, u256(refund_int))
        self._assert_conservation()
        return f"UNREVEALED_EXPIRED:{int(audit_id)}:PENALTY={penalty_int}:REFUND={refund_int}"

    # -------------------------------------------------------------------------
    # Stage 3: Sequential Wald SPRT Sampling (1 Narrow Judgment per Tx)
    # -------------------------------------------------------------------------

    @gl.public.write
    def step_audit_sample(self, audit_id: u256) -> str:
        """
        Permissionless trigger advancing the active SPRT audit by exactly ONE entry
        from the frozen Fisher-Yates permutation. Dispatches a single narrow judgment
        to VerityCitationJudge; verdict settlement happens strictly on finality callback.
        """
        self._assert_non_payable()
        audit = self._load_audit(audit_id)
        if audit["status"] != AUDIT_ACTIVE:
            raise gl.vm.UserError("AUDIT_NOT_ACTIVE")
        now = _current_timestamp()
        if now > int(audit["audit_deadline"]):
            raise gl.vm.UserError("AUDIT_DEADLINE_PASSED")

        cursor = int(audit["next_cursor"])
        order = audit["sample_order"]
        if cursor >= len(order):
            raise gl.vm.UserError("NO_SAMPLES_REMAINING")

        corpus = self._load_corpus(u256(int(audit["corpus_id"])))
        entry_idx = int(order[cursor])
        entry = corpus["entries"][entry_idx]
        seq = len(audit["samples"]) + 1

        audit["status"] = AUDIT_SAMPLE_IN_FLIGHT
        audit["in_flight_seq"] = seq
        audit["in_flight_entry_idx"] = entry_idx
        self._save_audit(audit_id, audit)

        judge = gl.get_contract_at(self.judge_address)
        judge.emit(on="accepted").audit_citation_sample(
            u256(int(audit_id)),
            u256(seq),
            u256(entry_idx),
            str(corpus["grounding_rule"]),
            str(entry["claim"]),
            str(entry["source_url"]),
            str(entry["anchor"]),
        )
        return f"SAMPLE_DISPATCHED:{int(audit_id)}:SEQ={seq}:ENTRY={entry_idx}"

    @gl.public.write
    def on_sample_judged(
        self,
        audit_id: u256,
        sample_seq: u256,
        entry_idx: u256,
        fetch_status: str,
        slice_sha256: str,
        verdict: str,
        verbatim_quote: str,
    ) -> str:
        """
        Finality callback invoked strictly by VerityCitationJudge via emit(on='finalized').
        Updates the scaled-integer Wald SPRT log-likelihood ratio and triggers deterministic
        early-stop financial settlement ONLY after consensus finality.
        """
        self._assert_non_payable()
        self._assert_judge_caller()
        audit = self._load_audit(audit_id)
        if audit["status"] != AUDIT_SAMPLE_IN_FLIGHT:
            return f"IGNORED_NOT_IN_FLIGHT:{audit['status']}"
        if int(sample_seq) != int(audit["in_flight_seq"]) or int(entry_idx) != int(audit["in_flight_entry_idx"]):
            return "IGNORED_STALE_SAMPLE_CALLBACK"

        now = _current_timestamp()
        cid = u256(int(audit["corpus_id"]))
        corpus = self._load_corpus(cid)
        profile = SPRT_PROFILES[audit["profile_id"]]

        f_status = str(fetch_status).strip().upper()
        s_verdict = str(verdict).strip().upper()
        s_digest = str(slice_sha256).strip()
        s_quote = str(verbatim_quote).strip()

        # Retry allowance for transient upstream fetch errors (max 1 retry before advancing cursor)
        transient = (s_verdict == "INSUFFICIENT_EVIDENCE" and f_status == "FETCH_ERROR")
        retries = int(audit["in_flight_retries"])

        new_llr, delta, decision = apply_sprt_step(
            current_llr=int(audit["llr_scaled"]),
            verdict=s_verdict,
            fetch_status=f_status,
            profile=profile,
            samples_counted=int(audit["samples_counted"]),
            total_entries=int(corpus["entry_count"]),
        )

        if delta != 0:
            audit["samples_counted"] = int(audit["samples_counted"]) + 1

        if transient and retries < MAX_TRANSIENT_RETRIES_PER_SAMPLE:
            audit["in_flight_retries"] = retries + 1
        else:
            audit["next_cursor"] = int(audit["next_cursor"]) + 1
            audit["in_flight_retries"] = 0

        audit["llr_scaled"] = new_llr
        audit["samples"].append(
            {
                "seq": int(sample_seq),
                "entry_idx": int(entry_idx),
                "fetch_status": f_status,
                "slice_sha256": s_digest,
                "verdict": s_verdict,
                "verbatim_quote": s_quote,
                "llr_delta": delta,
                "llr_after": new_llr,
                "finalized_at": now,
            }
        )

        # If all entries were walked (including any neutral INSUFFICIENT_EVIDENCE skips) without crossing A/B
        if decision == "CONTINUE" and int(audit["next_cursor"]) >= len(audit["sample_order"]):
            decision = "CERTIFIED_TRUNCATED" if new_llr <= 0 else "REJECTED_TRUNCATED"

        if decision in ("CERTIFIED_SOUND", "CERTIFIED_TRUNCATED"):
            bond = u256(int(corpus["bond_wei"]))
            stake = u256(int(audit["stake_wei"]))
            total_payout = _safe_add_u256(bond, stake)
            pub = _to_address(corpus["publisher"])

            audit["status"] = AUDIT_SETTLED_CERTIFIED
            audit["stake_wei"] = 0
            audit["terminal_decision"] = decision
            audit["settled_at"] = now
            self._save_audit(audit_id, audit)

            corpus["status"] = CORPUS_CERTIFIED_SOUND
            corpus["bond_wei"] = 0
            self._save_corpus(cid, corpus)

            self.total_publisher_bonds = _safe_sub_u256(self.total_publisher_bonds, bond)
            self.total_auditor_stakes = _safe_sub_u256(self.total_auditor_stakes, stake)
            self._credit_claimable(pub, total_payout)
            self._assert_conservation()
            return f"SETTLED:{decision}:LLR={new_llr}"

        if decision in ("REJECTED_DEFECTIVE", "REJECTED_TRUNCATED"):
            bond = u256(int(corpus["bond_wei"]))
            stake = u256(int(audit["stake_wei"]))
            total_payout = _safe_add_u256(bond, stake)
            aud = _to_address(audit["auditor"])

            audit["status"] = AUDIT_SETTLED_REJECTED
            audit["stake_wei"] = 0
            audit["terminal_decision"] = decision
            audit["settled_at"] = now
            self._save_audit(audit_id, audit)

            corpus["status"] = CORPUS_REJECTED_DEFECTIVE
            corpus["bond_wei"] = 0
            self._save_corpus(cid, corpus)

            self.total_publisher_bonds = _safe_sub_u256(self.total_publisher_bonds, bond)
            self.total_auditor_stakes = _safe_sub_u256(self.total_auditor_stakes, stake)
            self._credit_claimable(aud, total_payout)
            self._assert_conservation()
            return f"SETTLED:{decision}:LLR={new_llr}"

        # Continue sequential sampling
        audit["status"] = AUDIT_ACTIVE
        self._save_audit(audit_id, audit)
        self._assert_conservation()
        return f"CONTINUE:LLR={new_llr}:NEXT_CURSOR={audit['next_cursor']}"

    @gl.public.write
    def expire_stalled_audit(self, audit_id: u256) -> str:
        """
        Deterministic deadline + grace_period fallback.
        If an audit stalls (either in ACTIVE or SAMPLE_IN_FLIGHT) past audit_deadline + grace_period,
        any unfinalized in-flight sample is recorded as INSUFFICIENT_EVIDENCE (delta=0) and BOTH
        publisher bond and auditor stake are refunded 100% so zero funds ever lock forever.
        """
        self._assert_non_payable()
        audit = self._load_audit(audit_id)
        if audit["status"] not in (AUDIT_ACTIVE, AUDIT_SAMPLE_IN_FLIGHT):
            raise gl.vm.UserError("AUDIT_NOT_EXPIRABLE")
        now = _current_timestamp()
        if now <= int(audit["grace_deadline"]):
            raise gl.vm.UserError("GRACE_DEADLINE_NOT_REACHED")

        cid = u256(int(audit["corpus_id"]))
        corpus = self._load_corpus(cid)

        if audit["status"] == AUDIT_SAMPLE_IN_FLIGHT:
            audit["samples"].append(
                {
                    "seq": int(audit["in_flight_seq"]),
                    "entry_idx": int(audit["in_flight_entry_idx"]),
                    "fetch_status": "TIMEOUT_FALLBACK",
                    "slice_sha256": "",
                    "verdict": "INSUFFICIENT_EVIDENCE",
                    "verbatim_quote": "",
                    "llr_delta": 0,
                    "llr_after": int(audit["llr_scaled"]),
                    "finalized_at": now,
                }
            )

        bond = u256(int(corpus["bond_wei"]))
        stake = u256(int(audit["stake_wei"]))
        pub = _to_address(corpus["publisher"])
        aud = _to_address(audit["auditor"])

        audit["status"] = AUDIT_SETTLED_EXPIRED_REFUNDED
        audit["stake_wei"] = 0
        audit["terminal_decision"] = "EXPIRED_REFUNDED"
        audit["settled_at"] = now
        self._save_audit(audit_id, audit)

        corpus["status"] = CORPUS_AUDIT_EXPIRED_REFUNDED
        corpus["bond_wei"] = 0
        self._save_corpus(cid, corpus)

        self.total_publisher_bonds = _safe_sub_u256(self.total_publisher_bonds, bond)
        self.total_auditor_stakes = _safe_sub_u256(self.total_auditor_stakes, stake)
        self._credit_refundable(pub, bond)
        self._credit_refundable(aud, stake)
        self._assert_conservation()
        return f"AUDIT_EXPIRED_REFUNDED:{int(audit_id)}"

    # -------------------------------------------------------------------------
    # Stage 4: Finality-Gated Pull Withdrawals (EOA via _EvmRecipient)
    # -------------------------------------------------------------------------

    @gl.public.write
    def claim_winnings(self) -> u256:
        self._assert_non_payable()
        sender = _to_address(gl.message.sender_address)
        amount = self.claimable_balances.get(sender, u256(0))
        if int(amount) <= 0:
            raise gl.vm.UserError("NO_CLAIMABLE_BALANCE")

        self.claimable_balances[sender] = u256(0)
        self.total_claimable = _safe_sub_u256(self.total_claimable, amount)
        self.total_outbound_wei = _safe_add_u256(self.total_outbound_wei, amount)
        self._assert_conservation()

        _EvmRecipient(sender).emit_transfer(value=amount)
        return amount

    @gl.public.write
    def withdraw_refund(self) -> u256:
        self._assert_non_payable()
        sender = _to_address(gl.message.sender_address)
        amount = self.refundable_balances.get(sender, u256(0))
        if int(amount) <= 0:
            raise gl.vm.UserError("NO_REFUNDABLE_BALANCE")

        self.refundable_balances[sender] = u256(0)
        self.total_refundable = _safe_sub_u256(self.total_refundable, amount)
        self.total_outbound_wei = _safe_add_u256(self.total_outbound_wei, amount)
        self._assert_conservation()

        _EvmRecipient(sender).emit_transfer(value=amount)
        return amount

    # -------------------------------------------------------------------------
    # Read-Only Views (Wallet-Free Frontend Inspection & Proof Verification)
    # -------------------------------------------------------------------------

    @gl.public.view
    def get_protocol_info(self) -> dict[str, Any]:
        lhs = (
            int(self.total_publisher_bonds)
            + int(self.total_auditor_stakes)
            + int(self.total_claimable)
            + int(self.total_refundable)
        )
        rhs = int(self.total_inbound_wei) - int(self.total_outbound_wei)
        return {
            "judge_address": str(self.judge_address),
            "corpus_count": int(self.corpus_counter),
            "audit_count": int(self.audit_counter),
            "total_inbound_wei": int(self.total_inbound_wei),
            "total_outbound_wei": int(self.total_outbound_wei),
            "total_publisher_bonds": int(self.total_publisher_bonds),
            "total_auditor_stakes": int(self.total_auditor_stakes),
            "total_claimable": int(self.total_claimable),
            "total_refundable": int(self.total_refundable),
            "contract_balance_wei": int(self.balance),
            "conservation_ok": lhs == rhs,
            "sprt_scale": SPRT_SCALE,
            "profiles": SPRT_PROFILES,
        }

    @gl.public.view
    def get_corpus(self, corpus_id: u256) -> str:
        cid = u256(int(corpus_id))
        if cid not in self.corpora:
            return ""
        return self.corpora[cid]

    @gl.public.view
    def get_audit(self, audit_id: u256) -> str:
        aid = u256(int(audit_id))
        if aid not in self.audits:
            return ""
        return self.audits[aid]

    @gl.public.view
    def get_account_balances(self, account_addr: str) -> dict[str, int]:
        addr = _to_address(account_addr)
        return {
            "claimable_wei": int(self.claimable_balances.get(addr, u256(0))),
            "refundable_wei": int(self.refundable_balances.get(addr, u256(0))),
        }

    @gl.public.view
    def list_corpora_summary(self) -> str:
        items: list[dict[str, Any]] = []
        total = int(self.corpus_counter)
        for idx in range(1, total + 1):
            c = json.loads(self.corpora[u256(idx)])
            items.append(
                {
                    "corpus_id": c["corpus_id"],
                    "publisher": c["publisher"],
                    "domain_title": c["domain_title"],
                    "profile_id": c["profile_id"],
                    "entry_count": c["entry_count"],
                    "bond_wei": c["bond_wei"],
                    "status": c["status"],
                    "vetting_reason": c["vetting_reason"],
                    "active_audit_id": c["active_audit_id"],
                    "audit_ids": c["audit_ids"],
                    "manifest_sha256": c["manifest_sha256"],
                }
            )
        return json.dumps(items, sort_keys=True, separators=(",", ":"))
