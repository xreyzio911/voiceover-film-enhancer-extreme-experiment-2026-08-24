from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping


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
    role: str
    enabled_by_default: bool


def _artifact(
    model_id: str,
    component: str,
    package_name: str,
    version: str,
    sha256: str,
    filename: str,
    source_url: str,
    role: str,
    enabled: bool,
) -> ModelArtifact:
    return ModelArtifact(
        model_id=model_id,
        component=component,
        package_name=package_name,
        version=version,
        revision=f"pypi:{version}",
        sha256=sha256,
        filename=filename,
        source_url=source_url,
        role=role,
        enabled_by_default=enabled,
    )


SILERO_VAD_WHEEL = {
    "package_name": "silero-vad",
    "version": "6.2.1",
    "sha256": "09de93c4d874bb19c53e62a47dd38be5f163cedad2b5599583231f2a84ef79cb",
    "filename": "silero_vad-6.2.1-py3-none-any.whl",
    "source_url": "https://files.pythonhosted.org/packages/0b/2b/48566f29a8b53d856ceb1994f209122749b3fda0a733a07e82047257de7a/silero_vad-6.2.1-py3-none-any.whl",
}

SPEECHONNXMETRICS_WHEEL = {
    "package_name": "speechonnxmetrics",
    "version": "0.0.1",
    "sha256": "50f1c88c4fd6bc9319e2194973c86f2204ad22a44ac725b0294cc9b87c6a45dc",
    "filename": "speechonnxmetrics-0.0.1-py3-none-any.whl",
    "source_url": "https://files.pythonhosted.org/packages/46/b4/7721b25714363de1ad956c9437a4315d48ddec5bd77014627ad72c6ef578/speechonnxmetrics-0.0.1-py3-none-any.whl",
}

SPEAKERONNX_WHEEL = {
    "package_name": "speakeronnx",
    "version": "0.0.1",
    "sha256": "56209f4e6f95518eb5bd592c5a828264c562f220309c998043a70efc44ae2146",
    "filename": "speakeronnx-0.0.1-py3-none-any.whl",
    "source_url": "https://files.pythonhosted.org/packages/fa/9f/93d04fe2fa7ca0a9f641b549dd4e35713b0d3bc7c62fb5e3835a3fbe481d/speakeronnx-0.0.1-py3-none-any.whl",
}

DEEPFILTERNET_WHEEL = {
    "package_name": "deepfilternet",
    "version": "0.5.6",
    "sha256": "99f5688d954fcfa8f853bf8bb8c3b2a59e4f9dc5d95643c9e6a32053234ba7c6",
    "filename": "deepfilternet-0.5.6-py3-none-any.whl",
    "source_url": "https://files.pythonhosted.org/packages/70/71/2edcc970c4dc689c301ea83e89a169fde08d6af0dfb26b14009ab27ee105/deepfilternet-0.5.6-py3-none-any.whl",
}


MODEL_MANIFEST: Mapping[str, ModelArtifact] = MappingProxyType(
    {
        "silero_vad_v6": _artifact("silero_vad_v6", "silero_vad", role="analysis", enabled=True, **SILERO_VAD_WHEEL),
        "dnsmos_sig_bak_ovrl": _artifact(
            "dnsmos_sig_bak_ovrl",
            "dnsmos",
            role="analysis",
            enabled=True,
            **SPEECHONNXMETRICS_WHEEL,
        ),
        "dnsmos_p808": _artifact(
            "dnsmos_p808",
            "dnsmos_p808",
            role="analysis",
            enabled=True,
            **SPEECHONNXMETRICS_WHEEL,
        ),
        "sigmos": _artifact("sigmos", "sigmos", role="analysis", enabled=True, **SPEECHONNXMETRICS_WHEEL),
        "utmos": _artifact("utmos", "utmos", role="analysis", enabled=True, **SPEECHONNXMETRICS_WHEEL),
        "speakeronnx_resnet34": _artifact(
            "speakeronnx_resnet34",
            "speakeronnx",
            role="analysis",
            enabled=True,
            **SPEAKERONNX_WHEEL,
        ),
        "deepfilternet3": _artifact(
            "deepfilternet3",
            "deepfilternet3",
            role="repair_candidate",
            enabled=False,
            **DEEPFILTERNET_WHEEL,
        ),
    }
)

DEFAULT_ANALYSIS_MODELS = tuple(
    model_id
    for model_id, artifact in MODEL_MANIFEST.items()
    if artifact.enabled_by_default and artifact.role == "analysis"
)


def validate_manifest(manifest: Mapping[str, ModelArtifact]) -> tuple[str, ...]:
    errors: list[str] = []
    for model_id, artifact in manifest.items():
        if model_id != artifact.model_id:
            errors.append(f"{model_id}: key mismatch")
        if artifact.revision != f"pypi:{artifact.version}":
            errors.append(f"{model_id}: invalid revision")
        if len(artifact.sha256) != 64 or artifact.sha256 == "0" * 64:
            errors.append(f"{model_id}: invalid sha256")
        rendered = f"{artifact.model_id} {artifact.version} {artifact.revision} {artifact.source_url}".lower()
        if any(
            term in rendered
            for term in (
                "latest",
                "main",
                "master",
                "head",
                "nisqa",
                "noncommercial",
                "non-commercial",
                "cc-by-nc",
                "example.",
            )
        ):
            errors.append(f"{model_id}: disallowed mutable or noncommercial asset")
        if not artifact.source_url.startswith("https://files.pythonhosted.org/"):
            errors.append(f"{model_id}: source url is not an immutable PyPI distribution")
        if artifact.enabled_by_default and artifact.role != "analysis":
            errors.append(f"{model_id}: default model must be analysis only")
    return tuple(errors)
