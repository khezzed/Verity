import hashlib
import json
import pytest

from conftest import Address, UserError, load_contract_module, u256

DEPLOYER = "0x1111111111111111111111111111111111111111"
PUBLISHER = "0x2222222222222222222222222222222222222222"
AUDITOR = "0x3333333333333333333333333333333333333333"
JUDGE_ADDR = "0x9999999999999999999999999999999999999999"


def _sample_entries(count: int = 6) -> str:
    urls = [
        ("RFC 2104 defines HMAC with ipad 0x36 and opad 0x5C.", "https://www.rfc-editor.org/rfc/rfc2104.txt", "0x36"),
        ("RFC 8259 mandates UTF-8 encoding for external JSON text.", "https://www.rfc-editor.org/rfc/rfc8259.txt", "UTF-8"),
        ("RFC 6962 defines Certificate Transparency binary Merkle Hash Trees using SHA-256.", "https://www.rfc-editor.org/rfc/rfc6962.txt", "SHA-256"),
        ("RFC 1321 defines MD5 as producing a 128-bit message digest.", "https://www.rfc-editor.org/rfc/rfc1321.txt", "128-bit"),
        ("RFC 8446 removes static RSA cipher suites for forward secrecy.", "https://www.rfc-editor.org/rfc/rfc8446.txt", "static RSA"),
        ("Wikipedia revision 333954216 defines hash trees as trees of summary hashes.", "https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&format=json&formatversion=2&revids=333954216", "hash tree"),
        ("Archive snapshot 20040326113623 captures the Hashcash FAQ.", "https://web.archive.org/web/20040326113623id_/http://www.hashcash.org/faq/", "hashcash"),
        ("Pinned third-party commit captures IgnoreAttacker.py source code.", "https://raw.githubusercontent.com/liu00222/Open-Prompt-Injection/fbed5cca347488f88363790ae3ae97c56116da6a/OpenPromptInjection/attackers/IgnoreAttacker.py", "Ignore"),
    ]
    return json.dumps(
        [{"claim": urls[i % len(urls)][0], "source_url": urls[i % len(urls)][1], "anchor": urls[i % len(urls)][2]} for i in range(count)]
    )


def _deploy_vault(harness):
    mod = load_contract_module("contracts/verity_audit_vault.py", harness)
    harness.set_ctx(sender=DEPLOYER, value=0, timestamp=1_760_000_000)
    vault = mod.VerityAuditVault(JUDGE_ADDR)
    return mod, vault


def test_immutable_url_allowlist(harness):
    mod, _ = _deploy_vault(harness)
    # Valid immutable third-party URLs
    assert mod.is_immutable_source_url("https://www.rfc-editor.org/rfc/rfc2104.txt")
    assert mod.is_immutable_source_url(
        "https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&format=json&formatversion=2&revids=333954216"
    )
    assert mod.is_immutable_source_url(
        "https://raw.githubusercontent.com/liu00222/Open-Prompt-Injection/fbed5cca347488f88363790ae3ae97c56116da6a/OpenPromptInjection/attackers/IgnoreAttacker.py"
    )
    assert mod.is_immutable_source_url(
        "https://web.archive.org/web/20040326113623id_/http://www.hashcash.org/faq/"
    )

    # Rejected mutable or unsafe URLs
    assert not mod.is_immutable_source_url("https://raw.githubusercontent.com/org/repo/main/file.txt")
    assert not mod.is_immutable_source_url("https://raw.githubusercontent.com/org/repo/abcd1234/file.txt")
    assert not mod.is_immutable_source_url("https://web.archive.org/web/20040326113623/http://www.hashcash.org/faq/")  # missing id_
    assert not mod.is_immutable_source_url("https://en.wikipedia.org/wiki/Merkle_tree")  # mutable live page
    assert not mod.is_immutable_source_url("https://evil.example.com/fake-evidence.txt")
    assert not mod.is_immutable_source_url("https://www.rfc-editor.org/rfc/rfc2104.txt#frag")


def test_sprt_integer_math_early_stop_and_single_error_tolerance(harness):
    mod, _ = _deploy_vault(harness)
    prof = mod.SPRT_PROFILES["STANDARD_90"]

    # 3 clean passes -> still CONTINUE
    llr = 0
    for step in range(3):
        llr, delta, dec = mod.apply_sprt_step(llr, "SUPPORTED", "OK", prof, step, 10)
        assert delta == -587787
        assert dec == "CONTINUE"
    # 4th clean pass -> early-stop CERTIFIED_SOUND (60% of 10-entry corpus skipped!)
    llr, _, dec = mod.apply_sprt_step(llr, "SUPPORTED", "OK", prof, 3, 10)
    assert llr == -2351148 <= prof["bound_certify"]
    assert dec == "CERTIFIED_SOUND"

    # 1 defect alone does NOT slash (stays CONTINUE!)
    llr, delta, dec = mod.apply_sprt_step(0, "UNSUPPORTED", "OK", prof, 0, 10)
    assert delta == 1609438
    assert dec == "CONTINUE"

    # 2nd defect crosses upper Reject bound -> REJECTED_DEFECTIVE
    llr, _, dec = mod.apply_sprt_step(llr, "UNSUPPORTED", "OK", prof, 1, 10)
    assert llr == 3218876 >= prof["bound_reject"]
    assert dec == "REJECTED_DEFECTIVE"

    # Recovery: 1 defect followed by 7 passes recovers to CERTIFIED_SOUND
    llr = 1609438
    for step in range(1, 7):
        llr, _, dec = mod.apply_sprt_step(llr, "SUPPORTED", "OK", prof, step, 10)
        assert dec == "CONTINUE"
    llr, _, dec = mod.apply_sprt_step(llr, "SUPPORTED", "OK", prof, 7, 10)
    assert dec == "CERTIFIED_SOUND"


def test_fisher_yates_determinism(harness):
    mod, _ = _deploy_vault(harness)
    o1 = mod.deterministic_fisher_yates_order("a" * 64, 10)
    o2 = mod.deterministic_fisher_yates_order("a" * 64, 10)
    o3 = mod.deterministic_fisher_yates_order("b" * 64, 10)
    assert o1 == o2
    assert sorted(o1) == list(range(10))
    assert o1 != o3


def test_payable_invalid_input_refunds_without_stranding(harness):
    _, vault = _deploy_vault(harness)
    # Publisher sends 25 wei with a mutable (disallowed) GitHub /main/ URL
    bad_entries = json.dumps(
        [{"claim": "Valid length claim string here.", "source_url": "https://raw.githubusercontent.com/a/b/main/c.txt", "anchor": "x"}] * 4
    )
    harness.set_ctx(sender=PUBLISHER, value=25)
    res = vault.submit_corpus("Bad URL Brief", "Each claim must be explicitly substantiated by the cited spec.", "STANDARD_90", bad_entries, u256(300), u256(120), u256(600))
    assert res == "REFUNDED_ERROR:NON_IMMUTABLE_URL_0"

    bals = vault.get_account_balances(PUBLISHER)
    assert bals["refundable_wei"] == 25
    assert vault.get_protocol_info()["conservation_ok"] is True

    harness.set_ctx(sender=PUBLISHER, value=0)
    withdrawn = vault.withdraw_refund()
    assert int(withdrawn) == 25
    assert harness.emitted_transfers[-1] == {"kind": "evm_eoa", "target": PUBLISHER, "value": 25, "on": "finalized"}
    assert vault.get_protocol_info()["conservation_ok"] is True


def test_rulegate_reject_vague_and_refund(harness):
    _, vault = _deploy_vault(harness)
    harness.set_ctx(sender=PUBLISHER, value=50)
    res = vault.submit_corpus(
        "Vague Innovation Brief",
        "Claims pass if the cited document feels innovative and shows good progress.",
        "STANDARD_90",
        _sample_entries(4),
        u256(300),
        u256(120),
        u256(600),
    )
    assert res.startswith("SUBMITTED:1:")
    assert harness.emitted_calls[-1]["method"] == "vet_corpus_standard"

    # Judge finality callback rejects vague rule
    harness.set_ctx(sender=JUDGE_ADDR, value=0)
    cb = vault.on_standard_vetted(u256(1), "REJECTED_VAGUE", "SUBJECTIVE_CRITERIA")
    assert cb == "CORPUS_REJECTED_VAGUE:1:SUBJECTIVE_CRITERIA"
    c = json.loads(vault.get_corpus(u256(1)))
    assert c["status"] == "REJECTED_VAGUE"
    assert vault.get_account_balances(PUBLISHER)["refundable_wei"] == 50

    harness.set_ctx(sender=PUBLISHER, value=0)
    vault.withdraw_refund()
    assert vault.get_account_balances(PUBLISHER)["refundable_wei"] == 0
    assert vault.get_protocol_info()["conservation_ok"] is True


def test_full_sound_corpus_early_stop_certification(harness):
    _, vault = _deploy_vault(harness)
    harness.set_ctx(sender=PUBLISHER, value=100, timestamp=1_760_000_000)
    vault.submit_corpus(
        "Internet Crypto Standards",
        "Each factual claim must be explicitly stated in the cited immutable technical specification.",
        "STANDARD_90",
        _sample_entries(8),
        u256(600),
        u256(120),
        u256(1200),
    )
    harness.set_ctx(sender=JUDGE_ADDR, value=0, timestamp=1_760_000_020)
    vault.on_standard_vetted(u256(1), "ACCEPTED", "OBJECTIVE_STANDARD")

    # Commit & reveal audit seed
    salt = "verity-audit-secret-42"
    commit = hashlib.sha256(salt.encode("utf-8")).hexdigest()
    harness.set_ctx(sender=AUDITOR, value=100, timestamp=1_760_000_030)
    assert vault.commit_audit(u256(1), commit) == "AUDIT_COMMITTED:1"

    harness.set_ctx(sender=AUDITOR, value=0, timestamp=1_760_000_040)
    rev = vault.reveal_audit_seed(u256(1), salt)
    assert rev.startswith("SEED_REVEALED:1:")
    audit = json.loads(vault.get_audit(u256(1)))
    order = audit["sample_order"]
    assert len(order) == 8 and sorted(order) == list(range(8))

    # Step 4 clean SUPPORTED samples -> early stop at 4/8!
    for seq in range(1, 5):
        harness.set_ctx(sender=AUDITOR, value=0, timestamp=1_760_000_050 + seq * 10)
        step_res = vault.step_audit_sample(u256(1))
        entry_idx = order[seq - 1]
        assert f"ENTRY={entry_idx}" in step_res

        harness.set_ctx(sender=JUDGE_ADDR, value=0, timestamp=1_760_000_055 + seq * 10)
        cb_res = vault.on_sample_judged(
            u256(1),
            u256(seq),
            u256(entry_idx),
            "OK",
            "a" * 64,
            "SUPPORTED",
            "Verbatim technical quote from immutable RFC specification.",
        )
        if seq < 4:
            assert cb_res.startswith("CONTINUE:")
        else:
            assert cb_res.startswith("SETTLED:CERTIFIED_SOUND:")

    c = json.loads(vault.get_corpus(u256(1)))
    a = json.loads(vault.get_audit(u256(1)))
    assert c["status"] == "CERTIFIED_SOUND"
    assert a["status"] == "SETTLED_CERTIFIED"
    assert len(a["samples"]) == 4  # Early-stopped! Saved 50% of 8-entry corpus
    assert vault.get_account_balances(PUBLISHER)["claimable_wei"] == 200
    assert vault.get_account_balances(AUDITOR)["claimable_wei"] == 0

    harness.set_ctx(sender=PUBLISHER, value=0)
    assert int(vault.claim_winnings()) == 200
    assert vault.get_protocol_info()["conservation_ok"] is True


def test_defective_corpus_early_stop_slash(harness):
    _, vault = _deploy_vault(harness)
    harness.set_ctx(sender=PUBLISHER, value=100, timestamp=1_760_000_000)
    vault.submit_corpus(
        "Defective AI Brief",
        "Each factual claim must be explicitly stated in the cited immutable technical specification.",
        "STANDARD_90",
        _sample_entries(6),
        u256(600),
        u256(120),
        u256(1200),
    )
    harness.set_ctx(sender=JUDGE_ADDR, value=0, timestamp=1_760_000_020)
    vault.on_standard_vetted(u256(1), "ACCEPTED", "OBJECTIVE_STANDARD")

    salt = "defective-seed-99"
    commit = hashlib.sha256(salt.encode("utf-8")).hexdigest()
    harness.set_ctx(sender=AUDITOR, value=100, timestamp=1_760_000_030)
    vault.commit_audit(u256(1), commit)
    harness.set_ctx(sender=AUDITOR, value=0, timestamp=1_760_000_040)
    vault.reveal_audit_seed(u256(1), salt)
    order = json.loads(vault.get_audit(u256(1)))["sample_order"]

    # Sample 1: SUPPORTED (-587,787), Sample 2: UNSUPPORTED (+1,021,651), Sample 3: UNSUPPORTED (+2,631,089 >= A -> REJECT!)
    verdicts = ["SUPPORTED", "UNSUPPORTED", "UNSUPPORTED"]
    for seq, v in enumerate(verdicts, start=1):
        harness.set_ctx(sender=AUDITOR, value=0, timestamp=1_760_000_050 + seq * 10)
        vault.step_audit_sample(u256(1))
        harness.set_ctx(sender=JUDGE_ADDR, value=0, timestamp=1_760_000_055 + seq * 10)
        res = vault.on_sample_judged(
            u256(1),
            u256(seq),
            u256(order[seq - 1]),
            "OK",
            "b" * 64,
            v,
            "Verbatim supporting quote." if v == "SUPPORTED" else "",
        )
        if seq < 3:
            assert res.startswith("CONTINUE:")
        else:
            assert res.startswith("SETTLED:REJECTED_DEFECTIVE:")

    assert vault.get_account_balances(AUDITOR)["claimable_wei"] == 200
    harness.set_ctx(sender=AUDITOR, value=0)
    assert int(vault.claim_winnings()) == 200
    assert vault.get_protocol_info()["conservation_ok"] is True


def test_all_deadline_fallbacks_prevent_locked_funds(harness):
    _, vault = _deploy_vault(harness)

    # 1. Stalled vetting fallback
    harness.set_ctx(sender=PUBLISHER, value=20, timestamp=1_760_000_000)
    vault.submit_corpus("Stalled Vet", "Objective written text check rule.", "STANDARD_90", _sample_entries(4), u256(300), u256(60), u256(300))
    harness.set_ctx(sender=PUBLISHER, value=0, timestamp=1_760_000_100)
    with pytest.raises(UserError, match="VETTING_DEADLINE_NOT_REACHED"):
        vault.reclaim_stalled_vetting(u256(1))
    harness.set_ctx(sender=PUBLISHER, value=0, timestamp=1_760_000_950)
    assert vault.reclaim_stalled_vetting(u256(1)) == "VETTING_EXPIRED_REFUNDED:1"
    assert vault.get_account_balances(PUBLISHER)["refundable_wei"] == 20

    # 2. Unrevealed commit anti-grief fallback (10% penalty to publisher, 90% refund to auditor, corpus reopens)
    harness.set_ctx(sender=PUBLISHER, value=100, timestamp=1_760_001_000)
    vault.submit_corpus("Fallback Test", "Objective written text check rule.", "STANDARD_90", _sample_entries(4), u256(600), u256(30), u256(60))
    harness.set_ctx(sender=JUDGE_ADDR, value=0, timestamp=1_760_001_010)
    vault.on_standard_vetted(u256(2), "ACCEPTED", "OBJECTIVE_STANDARD")

    harness.set_ctx(sender=AUDITOR, value=50, timestamp=1_760_001_020)
    vault.commit_audit(u256(2), "c" * 64)
    harness.set_ctx(sender=PUBLISHER, value=0, timestamp=1_760_001_060)  # past reveal_deadline (1020+30=1050)
    res_unrev = vault.expire_unrevealed_audit(u256(1))
    assert "PENALTY=5:REFUND=45" in res_unrev
    assert json.loads(vault.get_corpus(u256(2)))["status"] == "OPEN_FOR_AUDIT"
    assert vault.get_account_balances(PUBLISHER)["claimable_wei"] == 5
    assert vault.get_account_balances(AUDITOR)["refundable_wei"] == 45

    # 3. Stalled active/in-flight audit fallback past audit_deadline + grace_period
    salt = "stall-test"
    harness.set_ctx(sender=AUDITOR, value=50, timestamp=1_760_001_070)
    vault.commit_audit(u256(2), hashlib.sha256(salt.encode()).hexdigest())
    harness.set_ctx(sender=AUDITOR, value=0, timestamp=1_760_001_080)
    vault.reveal_audit_seed(u256(2), salt)
    harness.set_ctx(sender=AUDITOR, value=0, timestamp=1_760_001_090)
    vault.step_audit_sample(u256(2))  # now SAMPLE_IN_FLIGHT

    # Grace deadline = 1080 + 60 + 30 = 1170
    harness.set_ctx(sender=PUBLISHER, value=0, timestamp=1_760_001_200)
    assert vault.expire_stalled_audit(u256(2)) == "AUDIT_EXPIRED_REFUNDED:2"
    a2 = json.loads(vault.get_audit(u256(2)))
    assert a2["samples"][0]["verdict"] == "INSUFFICIENT_EVIDENCE"
    assert a2["samples"][0]["fetch_status"] == "TIMEOUT_FALLBACK"
    assert vault.get_account_balances(PUBLISHER)["refundable_wei"] == 120  # 20 + 100
    assert vault.get_account_balances(AUDITOR)["refundable_wei"] == 95     # 45 + 50
    assert vault.get_protocol_info()["conservation_ok"] is True
