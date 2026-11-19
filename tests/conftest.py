import importlib.util
import pathlib
import sys
import types
from typing import Any, Callable, Generic, TypeVar

import pytest

K = TypeVar("K")
V = TypeVar("V")
T = TypeVar("T")


class u256(int):
    def __new__(cls, val: int = 0):
        v = int(val)
        if v < 0 or v >= (1 << 256):
            raise OverflowError("u256 bounds exceeded")
        return super().__new__(cls, v)

    def __add__(self, other: Any) -> "u256":
        return u256(int(self) + int(other))

    def __sub__(self, other: Any) -> "u256":
        return u256(int(self) - int(other))


class Address(str):
    def __new__(cls, val: str = "0x0000000000000000000000000000000000000000"):
        v = str(val).lower()
        if not v.startswith("0x") or len(v) != 42:
            raise ValueError(f"Invalid Address: {val}")
        return super().__new__(cls, v)


class TreeMap(Generic[K, V], dict):
    pass


class DynArray(Generic[T], list):
    pass


def allow_storage(cls: Any) -> Any:
    return cls


class UserError(Exception):
    pass


class ReturnWrapper:
    def __init__(self, calldata: Any):
        self.calldata = calldata


class MockWebResponse:
    def __init__(self, status: int, body: bytes | str):
        self.status = status
        self.body = body if isinstance(body, bytes) else body.encode("utf-8")


class GenVMHarness:
    """In-process deterministic & mocked nondet test harness for Verity Intelligent Contracts."""

    def __init__(self):
        self.sender = Address("0x1111111111111111111111111111111111111111")
        self.contract_address = Address("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        self.value = u256(0)
        self.timestamp = 1_760_000_000
        self.emitted_calls: list[dict[str, Any]] = []
        self.emitted_transfers: list[dict[str, Any]] = []
        self.web_responses: dict[str, list[MockWebResponse]] = {}
        self.llm_replies: list[Any] = []
        self.nondet_validator_must_agree = True
        self.last_validator_result: bool | None = None

    def set_ctx(self, sender: str | None = None, value: int = 0, timestamp: int | None = None):
        if sender is not None:
            self.sender = Address(sender)
        self.value = u256(value)
        if timestamp is not None:
            self.timestamp = int(timestamp)

    def queue_web(self, url: str, status: int, body: str | bytes, repeat: int = 2):
        self.web_responses.setdefault(url, [])
        for _ in range(repeat):
            self.web_responses[url].append(MockWebResponse(status, body))

    def queue_llm(self, *replies: Any):
        self.llm_replies.extend(replies)

    def build_genlayer_module(self) -> types.ModuleType:
        harness = self
        mod = types.ModuleType("genlayer")

        class _Message:
            @property
            def sender_address(self):
                return harness.sender

            @property
            def contract_address(self):
                return harness.contract_address

            @property
            def value(self):
                return harness.value

            @property
            def timestamp(self):
                return harness.timestamp

        class _EmitProxy:
            def __init__(self, target: Address, on: str, value: u256):
                self._target = target
                self._on = on
                self._value = value

            def __getattr__(self, method_name: str):
                def _recorder(*args: Any, **kwargs: Any):
                    harness.emitted_calls.append(
                        {
                            "target": str(self._target),
                            "on": self._on,
                            "value": int(self._value),
                            "method": method_name,
                            "args": args,
                            "kwargs": kwargs,
                        }
                    )
                return _recorder

        class _ContractProxy:
            def __init__(self, addr: Any):
                self._addr = Address(str(addr))

            def emit(self, on: str = "accepted", value: u256 = u256(0)):
                return _EmitProxy(self._addr, on, value)

            def emit_transfer(self, value: u256 = u256(0), on: str = "finalized"):
                harness.emitted_transfers.append(
                    {"kind": "ic", "target": str(self._addr), "value": int(value), "on": on}
                )

        class _EvmInterfaceProxy:
            def __init__(self, addr: Any):
                self._addr = Address(str(addr))

            def emit_transfer(self, value: u256 = u256(0)):
                harness.emitted_transfers.append(
                    {"kind": "evm_eoa", "target": str(self._addr), "value": int(value), "on": "finalized"}
                )

        def _evm_contract_interface(_cls: Any):
            return _EvmInterfaceProxy

        class _WriteDec:
            def __call__(self, fn: Callable):
                return fn

            def payable(self, fn: Callable):
                return fn

        class _Public:
            view = staticmethod(lambda fn: fn)
            write = _WriteDec()

        class _Web:
            @staticmethod
            def get(url: str):
                q = harness.web_responses.get(url)
                if not q:
                    raise RuntimeError(f"Unmocked URL: {url}")
                return q.pop(0)

        class _Nondet:
            web = _Web()

            @staticmethod
            def exec_prompt(prompt: str, response_format: str = "text"):
                if not harness.llm_replies:
                    raise RuntimeError("No mocked LLM reply queued")
                return harness.llm_replies.pop(0)

        class _VM:
            UserError = UserError
            Return = ReturnWrapper

            @staticmethod
            def run_nondet_unsafe(leader_fn: Callable, validator_fn: Callable):
                leader_out = leader_fn()
                agreed = bool(validator_fn(ReturnWrapper(leader_out)))
                harness.last_validator_result = agreed
                if harness.nondet_validator_must_agree and not agreed:
                    raise UserError("CONSENSUS_DISAGREE")
                return leader_out

        class _EVM:
            contract_interface = staticmethod(_evm_contract_interface)

        class _ContractBase:
            def __new__(cls, *args: Any, **kwargs: Any):
                inst = super().__new__(cls)
                for name, ann in getattr(cls, "__annotations__", {}).items():
                    ann_str = str(ann)
                    if "TreeMap" in ann_str:
                        setattr(inst, name, TreeMap())
                    elif "DynArray" in ann_str:
                        setattr(inst, name, DynArray())
                return inst

            @property
            def balance(self) -> u256:
                inbound = getattr(self, "total_inbound_wei", u256(0))
                outbound = getattr(self, "total_outbound_wei", u256(0))
                return u256(max(0, int(inbound) - int(outbound)))

        class _GL:
            Contract = _ContractBase
            public = _Public()
            nondet = _Nondet()
            vm = _VM()
            evm = _EVM()
            message = _Message()

            @property
            def message_raw(self):
                return {"datetime": harness.timestamp}

            @staticmethod
            def get_contract_at(addr: Any):
                return _ContractProxy(addr)

        mod.gl = _GL()
        mod.u256 = u256
        mod.Address = Address
        mod.TreeMap = TreeMap
        mod.DynArray = DynArray
        mod.allow_storage = allow_storage
        mod.__all__ = ["gl", "u256", "Address", "TreeMap", "DynArray", "allow_storage"]
        return mod


def load_contract_module(rel_path: str, harness: GenVMHarness):
    sys.modules["genlayer"] = harness.build_genlayer_module()
    p = pathlib.Path(__file__).resolve().parent.parent / rel_path
    mod_name = f"_verity_test_{p.stem}"
    spec = importlib.util.spec_from_file_location(mod_name, p)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def harness():
    return GenVMHarness()
