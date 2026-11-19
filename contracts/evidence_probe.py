# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

import hashlib
import json
from typing import Any
from genlayer import *


def _extract_bounded_slice(raw_text: str, anchor: str, is_wiki_json: bool) -> dict[str, Any]:
    text = raw_text
    if is_wiki_json:
        try:
            obj = json.loads(raw_text)
            pages = obj.get("query", {}).get("pages", [])
            if isinstance(pages, list) and len(pages) > 0:
                revs = pages[0].get("revisions", [])
                if isinstance(revs, list) and len(revs) > 0:
                    text = str(revs[0].get("content", ""))
            elif isinstance(pages, dict):
                for p in pages.values():
                    revs = p.get("revisions", [])
                    if isinstance(revs, list) and len(revs) > 0:
                        text = str(revs[0].get("*", revs[0].get("content", "")))
                        break
        except Exception:
            pass

    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    lower = normalized.lower()
    anchor_clean = anchor.strip().lower()
    pos = lower.find(anchor_clean) if anchor_clean else -1
    anchor_found = pos >= 0
    if anchor_found:
        start = max(0, pos - 600)
        end = min(len(normalized), start + 2200)
        excerpt = normalized[start:end]
    else:
        excerpt = normalized[:2200]

    digest = hashlib.sha256(excerpt.encode("utf-8")).hexdigest()
    return {
        "anchor_found": anchor_found,
        "total_len": len(normalized),
        "slice_len": len(excerpt),
        "slice_sha256": digest,
        "preview": excerpt[:180],
    }


class EvidenceProbe(gl.Contract):
    """
    Step 2 pre-flight probe deployed on StudioNet before main Verity contracts.
    Verifies:
      1. Pinned GenVM runner acceptance.
      2. Validator reachability & exact byte-digest consensus across immutable sources.
      3. emit(on='finalized') callback delivery and payable emit_transfer(on='finalized').
    """

    results: TreeMap[str, str]
    callback_log: TreeMap[str, str]
    probe_count: u256
    refund_count: u256

    def __init__(self):
        self.probe_count = u256(0)
        self.refund_count = u256(0)

    @gl.public.write
    def probe_source(self, label: str, url: str, anchor: str) -> str:
        c_label = str(label)
        c_url = str(url)
        c_anchor = str(anchor)
        is_wiki = "wikipedia.org/w/api.php" in c_url

        def fetch_once() -> str:
            try:
                resp = gl.nondet.web.get(c_url)
                status = int(getattr(resp, "status", 0))
                body = getattr(resp, "body", b"")
                if isinstance(body, (bytes, bytearray)):
                    raw_text = body.decode("utf-8", errors="replace")
                else:
                    raw_text = str(body)
            except Exception as exc:
                return json.dumps(
                    {
                        "label": c_label,
                        "status": 0,
                        "error": str(exc)[:140],
                    },
                    sort_keys=True,
                )

            if status != 200:
                return json.dumps(
                    {
                        "label": c_label,
                        "status": status,
                        "error": f"HTTP_{status}",
                    },
                    sort_keys=True,
                )

            sliced = _extract_bounded_slice(raw_text, c_anchor, is_wiki)
            return json.dumps(
                {
                    "label": c_label,
                    "status": status,
                    "anchor_found": sliced["anchor_found"],
                    "total_len": sliced["total_len"],
                    "slice_len": sliced["slice_len"],
                    "slice_sha256": sliced["slice_sha256"],
                    "preview": sliced["preview"],
                },
                sort_keys=True,
            )

        def leader_fn() -> str:
            return fetch_once()

        def validator_fn(leader_res: Any) -> bool:
            if not isinstance(leader_res, gl.vm.Return):
                return False
            val_out = fetch_once()
            return leader_res.calldata == val_out

        agreed = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
        self.results[c_label] = agreed
        self.probe_count = u256(int(self.probe_count) + 1)
        return agreed

    @gl.public.write
    def trigger_finalized_callback(self, tag: str) -> str:
        c_tag = str(tag)
        self.callback_log[c_tag] = "DISPATCHED"
        me = gl.get_contract_at(gl.message.contract_address)
        me.emit(on="finalized").on_finalized_callback(c_tag)
        return f"DISPATCHED:{c_tag}"

    @gl.public.write
    def on_finalized_callback(self, tag: str) -> str:
        if gl.message.sender_address != gl.message.contract_address:
            raise gl.vm.UserError("ONLY_SELF_CALLBACK")
        c_tag = str(tag)
        self.callback_log[c_tag] = "FINALIZED_OK"
        return f"FINALIZED_OK:{c_tag}"

    @gl.public.write.payable
    def test_payable_refund(self) -> str:
        val = gl.message.value
        sender = gl.message.sender_address
        self.refund_count = u256(int(self.refund_count) + 1)
        if int(val) > 0:
            gl.get_contract_at(sender).emit_transfer(value=val, on="finalized")
        return f"REFUND_EMITTED:{int(val)}"

    @gl.public.view
    def get_result(self, label: str) -> str:
        if label in self.results:
            return self.results[label]
        return ""

    @gl.public.view
    def get_callback_status(self, tag: str) -> str:
        if tag in self.callback_log:
            return self.callback_log[tag]
        return "MISSING"

    @gl.public.view
    def get_summary(self) -> dict[str, Any]:
        return {
            "probe_count": int(self.probe_count),
            "refund_count": int(self.refund_count),
            "balance": int(self.balance),
        }
