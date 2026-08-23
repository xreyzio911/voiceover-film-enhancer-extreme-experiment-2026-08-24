from __future__ import annotations

import re
from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping

from .model_runtime import DEFAULT_RUNTIME_ARTIFACTS


@dataclass(frozen=True)
class ModelArtifact:
    model_id: str
    component: str
    package_name: str
    version: str
    revision: str
    sha256: str
    filename: str
    source_url: str
    license: str
    role: str
    enabled_by_default: bool
    shippable: bool


def _runtime_artifact(artifact_id: str, *, component: str, role: str, enabled: bool) -> ModelArtifact:
    artifact = next(item for item in DEFAULT_RUNTIME_ARTIFACTS if item.id == artifact_id)
    return ModelArtifact(
        model_id=artifact_id,
        component=component,
        package_name="onnx-artifact",
        version=artifact.version,
        revision=artifact.revision,
        sha256=artifact.sha256,
        filename=artifact.filename,
        source_url=artifact.source_url,
        license=artifact.license,
        role=role,
        enabled_by_default=enabled,
        shippable=True,
    )


MODEL_MANIFEST: Mapping[str, ModelArtifact] = MappingProxyType(
    {
        "silero-vad": _runtime_artifact("silero-vad", component="silero_vad", role="analysis", enabled=True),
        "dnsmos": _runtime_artifact("dnsmos", component="dnsmos", role="analysis", enabled=True),
        "dnsmos_p808": _runtime_artifact(
            "dnsmos_p808",
            component="dnsmos_p808",
            role="analysis",
            enabled=True,
        ),
        "sigmos": _runtime_artifact("sigmos", component="sigmos", role="analysis", enabled=True),
        "utmos": _runtime_artifact("utmos", component="utmos", role="analysis_optional", enabled=False),
        "deepfilternet3": ModelArtifact(
            model_id="deepfilternet3",
            component="deepfilternet3",
            package_name="",
            version="",
            revision="",
            sha256="",
            filename="",
            source_url="https://github.com/Rikorose/DeepFilterNet/issues/700",
            license="UNRESOLVED",
            role="deferred_license_review",
            enabled_by_default=False,
            shippable=False,
        ),
    }
)

DEFAULT_ANALYSIS_MODELS = tuple(
    model_id
    for model_id, artifact in MODEL_MANIFEST.items()
    if artifact.enabled_by_default and artifact.role == "analysis" and artifact.shippable
)

_HEX_40 = re.compile(r"^[0-9a-f]{40}$")
_HEX_64 = re.compile(r"^[0-9a-f]{64}$")


def validate_manifest(manifest: Mapping[str, ModelArtifact]) -> tuple[str, ...]:
    errors: list[str] = []
    for model_id, artifact in manifest.items():
        if model_id != artifact.model_id:
            errors.append(f"{model_id}: key mismatch")
        if artifact.enabled_by_default and (artifact.role != "analysis" or not artifact.shippable):
            errors.append(f"{model_id}: default model must be shippable analysis only")
        if not artifact.shippable:
            if artifact.license != "UNRESOLVED" or artifact.revision or artifact.sha256 or artifact.filename:
                errors.append(f"{model_id}: deferred model must not claim a shippable artifact")
            continue
        if artifact.license != "MIT":
            errors.append(f"{model_id}: unsupported deployment license")
        if not _HEX_40.fullmatch(artifact.revision):
            errors.append(f"{model_id}: revision must be an immutable commit")
        if not _HEX_64.fullmatch(artifact.sha256) or artifact.sha256 == "0" * 64:
            errors.append(f"{model_id}: invalid sha256")
        rendered = f"{artifact.model_id} {artifact.version} {artifact.revision} {artifact.source_url}".lower()
        if any(term in rendered for term in ("latest", "/main/", "/master/", "nisqa", "noncommercial")):
            errors.append(f"{model_id}: disallowed mutable or noncommercial asset")
        if not artifact.source_url.startswith(("https://raw.githubusercontent.com/", "https://huggingface.co/")):
            errors.append(f"{model_id}: artifact source is not an approved immutable host")
    return tuple(errors)
