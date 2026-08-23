from __future__ import annotations

import importlib
from types import ModuleType
from typing import Any
from unittest import TestCase


def require_module(case: TestCase, module_name: str) -> ModuleType:
    """Load a production module while keeping every missing contract visible in RED."""
    try:
        return importlib.import_module(module_name)
    except (ImportError, ModuleNotFoundError) as exc:
        case.fail(f"RED: implement production module {module_name}: {exc}")
        raise AssertionError("unreachable") from exc


def require_symbols(case: TestCase, module_name: str, *names: str) -> tuple[Any, ...]:
    module = require_module(case, module_name)
    missing = tuple(name for name in names if not hasattr(module, name))
    if missing:
        case.fail(f"RED: implement {module_name} symbols: {', '.join(missing)}")
    return tuple(getattr(module, name) for name in names)


class MutableClock:
    def __init__(self, value: float = 1_800_000_000.0) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds

