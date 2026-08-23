from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path


LICENSED_METRIC_IDS = ("dnsmos", "dnsmos_p808", "sigmos", "utmos")
DEFAULT_METRIC_IDS = ("dnsmos", "dnsmos_p808", "sigmos")


@dataclass(frozen=True)
class ArtifactSpec:
    id: str
    component: str
    version: str
    revision: str
    sha256: str
    filename: str
    license: str
    bundled_by_default: bool
    source_url: str = ""


DEFAULT_RUNTIME_ARTIFACTS = (
    ArtifactSpec(
        id="silero-vad",
        component="silero_vad",
        version="6.2.1",
        revision="7e30209a3e901f9842f81b225f3e93d8199902b1",
        sha256="1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
        filename="silero_vad_v6.2.1.onnx",
        license="MIT",
        bundled_by_default=True,
        source_url=(
            "https://raw.githubusercontent.com/snakers4/silero-vad/"
            "7e30209a3e901f9842f81b225f3e93d8199902b1/src/silero_vad/data/silero_vad.onnx"
        ),
    ),
    ArtifactSpec(
        id="dnsmos",
        component="dnsmos",
        version="speechonnxmetrics-0.0.1",
        revision="27691a53aa069b27be6ac957013d43b3c442da9d",
        sha256="269fbebdb513aa23cddfbb593542ecc540284a91849ac50516870e1ac78f6edd",
        filename="dnsmos_sig_bak_ovr.onnx",
        license="MIT",
        bundled_by_default=True,
        source_url=(
            "https://huggingface.co/TigreGotico/dnsmos-onnx/resolve/"
            "27691a53aa069b27be6ac957013d43b3c442da9d/sig_bak_ovr.onnx"
        ),
    ),
    ArtifactSpec(
        id="dnsmos_p808",
        component="dnsmos_p808",
        version="speechonnxmetrics-0.0.1",
        revision="27691a53aa069b27be6ac957013d43b3c442da9d",
        sha256="9246480c58567bc6affd4200938e77eef49468c8bc7ed3776d109c07456f6e91",
        filename="dnsmos_p808_model_v8.onnx",
        license="MIT",
        bundled_by_default=True,
        source_url=(
            "https://huggingface.co/TigreGotico/dnsmos-onnx/resolve/"
            "27691a53aa069b27be6ac957013d43b3c442da9d/model_v8.onnx"
        ),
    ),
    ArtifactSpec(
        id="sigmos",
        component="sigmos",
        version="speechonnxmetrics-0.0.1",
        revision="33ccd4fca5b8ffe03828530753f0b35769b8e880",
        sha256="f939dcc1945055a435565b4369e27dafd0f87df3cea4e2ff6eb81225e52cc53b",
        filename="sigmos_p804.onnx",
        license="MIT",
        bundled_by_default=True,
        source_url=(
            "https://huggingface.co/TigreGotico/sigmos-onnx/resolve/"
            "33ccd4fca5b8ffe03828530753f0b35769b8e880/"
            "model-sigmos_1697718653_41d092e8-epo-200.onnx"
        ),
    ),
    ArtifactSpec(
        id="utmos",
        component="utmos",
        version="speechonnxmetrics-0.0.1",
        revision="ff41b8f440cb12ecda18261f9ff7326d058275ce",
        sha256="ece7ddb0999d0f12ffe8d7586b3618b8b6fa89269b5152288e4440d686409f69",
        filename="utmos22_strong.onnx",
        license="MIT",
        bundled_by_default=False,
        source_url=(
            "https://huggingface.co/TigreGotico/utmos-onnx/resolve/"
            "ff41b8f440cb12ecda18261f9ff7326d058275ce/utmos22_strong.onnx"
        ),
    ),
)


def _unique_licensed_metrics(values: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    selected: list[str] = []
    for value in values:
        metric_id = value.strip().lower()
        if metric_id in LICENSED_METRIC_IDS and metric_id not in selected:
            selected.append(metric_id)
    return tuple(selected)


@dataclass(frozen=True)
class RuntimeConfig:
    model_dir: Path
    metric_ids: tuple[str, ...] = DEFAULT_METRIC_IDS
    artifacts: tuple[ArtifactSpec, ...] = DEFAULT_RUNTIME_ARTIFACTS
    max_analysis_seconds: float = 1_800.0
    vad_frame_ms: int = 10

    def __post_init__(self) -> None:
        if self.max_analysis_seconds <= 0:
            raise ValueError("max_analysis_seconds must be positive")
        if self.vad_frame_ms != 10:
            raise ValueError("the browser protection contract requires 10 ms VAD frames")
        artifact_ids = tuple(item.id for item in self.artifacts)
        if len(artifact_ids) != len(set(artifact_ids)):
            raise ValueError("runtime artifact ids must be unique")
        object.__setattr__(self, "model_dir", Path(self.model_dir).resolve())
        object.__setattr__(self, "metric_ids", _unique_licensed_metrics(list(self.metric_ids)))
        object.__setattr__(self, "artifacts", tuple(self.artifacts))

    @classmethod
    def from_env(cls) -> "RuntimeConfig":
        model_dir = Path(os.environ.get("EXTREME_ML_MODEL_DIR", "/opt/extreme/models"))
        requested = os.environ.get("EXTREME_ML_METRICS", ",".join(DEFAULT_METRIC_IDS))
        metric_ids = _unique_licensed_metrics(requested.split(","))
        raw_max_seconds = os.environ.get("EXTREME_ML_MAX_ANALYSIS_SECONDS", "1800")
        try:
            max_seconds = float(raw_max_seconds)
        except ValueError:
            max_seconds = 1_800.0
        max_seconds = min(2_160.0, max(1.0, max_seconds))
        return cls(model_dir=model_dir, metric_ids=metric_ids, max_analysis_seconds=max_seconds)

    def artifact(self, artifact_id: str) -> ArtifactSpec | None:
        return next((item for item in self.artifacts if item.id == artifact_id), None)


def sha256_file(path: Path, chunk_bytes: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(chunk_bytes), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_artifact(path: Path, artifact: ArtifactSpec) -> bool:
    candidate = Path(path)
    if not candidate.is_file():
        return False
    try:
        return sha256_file(candidate) == artifact.sha256
    except OSError:
        return False


def model_set_id(config: RuntimeConfig) -> str:
    selected = {"silero-vad", *config.metric_ids}
    identity = "\n".join(
        f"{item.id}:{item.version}:{item.revision}:{item.sha256}"
        for item in config.artifacts
        if item.id in selected
    )
    return f"extreme-advisory-{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:16]}"
