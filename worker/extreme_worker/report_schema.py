from __future__ import annotations

import json
import math
import re
from typing import Any


class ReportValidationError(ValueError):
    pass


PROHIBITED_AUTHORITY_KEYS = frozenset(
    {
        "action",
        "actions",
        "command",
        "commands",
        "processingdirective",
        "processingdirectives",
        "recommendedgaindb",
        "targetgaindb",
        "targetlufs",
        "normalizationtarget",
        "compressorsettings",
        "limitersettings",
        "ffmpegfilter",
        "filtergraph",
    }
)
PROHIBITED_INSTRUCTION = re.compile(
    r"\b(?:apply|add|increase|decrease|set|use|run)\s+"
    r"(?:[+-]?\d+(?:\.\d+)?\s*dB\s+of\s+gain|gain|normalization|compression|a\s+compressor|a\s+limiter|loudnorm|dynaudnorm)\b",
    re.IGNORECASE,
)
HEX_64 = re.compile(r"^[0-9a-f]{64}$")
HEX_40 = re.compile(r"^[0-9a-f]{40}$")


def _finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _assert_no_gain_authority(value: object, path: str = "report") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = re.sub(r"[^a-z]", "", str(key).lower())
            if normalized in PROHIBITED_AUTHORITY_KEYS:
                raise ReportValidationError(f"{path}.{key} would grant worker processing authority")
            _assert_no_gain_authority(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _assert_no_gain_authority(child, f"{path}[{index}]")
    elif isinstance(value, str) and PROHIBITED_INSTRUCTION.search(value):
        raise ReportValidationError(f"{path} contains a prohibited processing instruction")


def validate_source_report(payload: object, *, expected_source_sha256: str | None = None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ReportValidationError("report must be an object")
    encoded = json.dumps(payload, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > 16 * 1024 * 1024:
        raise ReportValidationError("report exceeds size limit")
    if (
        payload.get("schemaVersion") != 1
        or payload.get("advisoryOnly") is not True
        or payload.get("canBlockDelivery") is not False
        or payload.get("canChangeGainDb") is not False
        or payload.get("levelAuthority") != "gainPlanner"
    ):
        raise ReportValidationError("report must be advisory-only with gainPlanner authority")
    model_set_id = payload.get("modelSetId")
    if not isinstance(model_set_id, str) or not 1 <= len(model_set_id) <= 128:
        raise ReportValidationError("invalid model set id")

    source = payload.get("source")
    if not isinstance(source, dict) or not isinstance(source.get("sha256"), str) or not HEX_64.fullmatch(source["sha256"]):
        raise ReportValidationError("invalid source identity")
    if expected_source_sha256 is not None and source["sha256"] != expected_source_sha256:
        raise ReportValidationError("report source identity mismatch")
    if not _finite_number(source.get("durationMs")) or float(source["durationMs"]) < 0:
        raise ReportValidationError("invalid source duration")
    if not isinstance(source.get("sampleRate"), int) or isinstance(source.get("sampleRate"), bool) or source["sampleRate"] <= 0:
        raise ReportValidationError("invalid source sample rate")
    if not isinstance(source.get("channels"), int) or isinstance(source.get("channels"), bool) or source["channels"] <= 0:
        raise ReportValidationError("invalid source channels")

    candidate = payload.get("candidate")
    if candidate is not None:
        if not isinstance(candidate, dict):
            raise ReportValidationError("invalid candidate")
        if candidate.get("role") != "enhancement_candidate":
            raise ReportValidationError("invalid candidate role")
        if not isinstance(candidate.get("sha256"), str) or not HEX_64.fullmatch(candidate["sha256"]):
            raise ReportValidationError("invalid candidate identity")
        if not _finite_number(candidate.get("durationMs")) or float(candidate["durationMs"]) < 0:
            raise ReportValidationError("invalid candidate duration")
        if (
            candidate.get("sampleRate") != source["sampleRate"]
            or candidate.get("channels") != source["channels"]
            or abs(float(candidate["durationMs"]) - float(source["durationMs"])) > 1.0
        ):
            raise ReportValidationError("candidate facts disagree with source contract")

    vad = payload.get("vad")
    if not isinstance(vad, dict) or not _finite_number(vad.get("frameMs")) or float(vad["frameMs"]) <= 0:
        raise ReportValidationError("invalid VAD frame duration")
    frames = vad.get("frames")
    if not isinstance(frames, list) or len(frames) > 216_000:
        raise ReportValidationError("invalid VAD frame list")
    previous_end = 0.0
    for frame in frames:
        if not isinstance(frame, dict) or not all(
            _finite_number(frame.get(key)) for key in ("startMs", "endMs", "speechProbability")
        ):
            raise ReportValidationError("invalid VAD frame")
        start = float(frame["startMs"])
        end = float(frame["endMs"])
        probability = float(frame["speechProbability"])
        if start < previous_end or end <= start or probability < 0 or probability > 1:
            raise ReportValidationError("invalid VAD frame ordering or probability")
        previous_end = end

    metrics = payload.get("metrics")
    if not isinstance(metrics, dict) or len(metrics) > 128:
        raise ReportValidationError("invalid metrics object")
    for key, metric in metrics.items():
        if not isinstance(key, str) or not 1 <= len(key) <= 80 or not isinstance(metric, dict):
            raise ReportValidationError("invalid metric entry")
        value = metric.get("value")
        available = metric.get("available")
        if value is not None and not _finite_number(value):
            raise ReportValidationError("metric value must be finite or null")
        if not isinstance(available, bool) or not isinstance(metric.get("higherIsBetter"), bool):
            raise ReportValidationError("metric availability metadata is invalid")
        if available and value is None:
            raise ReportValidationError("available metric must have a value")

    models = payload.get("models")
    if not isinstance(models, list) or len(models) > 50:
        raise ReportValidationError("invalid model list")
    for model in models:
        if not isinstance(model, dict):
            raise ReportValidationError("invalid model entry")
        if not isinstance(model.get("id"), str) or not model["id"]:
            raise ReportValidationError("invalid model id")
        if not isinstance(model.get("version"), str) or not model["version"]:
            raise ReportValidationError("invalid model version")
        if not isinstance(model.get("revision"), str) or not HEX_40.fullmatch(model["revision"]):
            raise ReportValidationError("invalid model revision")
        if not isinstance(model.get("sha256"), str) or not HEX_64.fullmatch(model["sha256"]):
            raise ReportValidationError("invalid model checksum")
    telemetry = payload.get("telemetry")
    if not isinstance(telemetry, dict):
        raise ReportValidationError("invalid telemetry")
    if telemetry.get("candidateSelected") is True and candidate is None:
        raise ReportValidationError("selected candidate requires candidate identity")
    _assert_no_gain_authority(payload)
    return json.loads(encoded.decode("utf-8"))

def _finite_or_none(value: object) -> float | None:
    return float(value) if _finite_number(value) else None


def build_report(
    *,
    job_id: str,
    source_sha256: str,
    result_sha256: str,
    metrics: dict[str, object],
    findings: list[dict[str, object]],
) -> dict[str, object]:
    clean_findings = [
        {
            "code": str(item.get("code", ""))[:64],
            "severity": "warn" if item.get("severity") == "warn" else "info",
            "message": str(item.get("message", ""))[:500],
        }
        for item in findings[:50]
        if str(item.get("code", "")) and str(item.get("message", ""))
    ]
    return {
        "schemaVersion": 1,
        "advisoryOnly": True,
        "canBlockDelivery": False,
        "deliveryGate": "never",
        "canChangeGainDb": False,
        "rawAudioLogged": False,
        "transcriptLogged": False,
        "jobId": job_id,
        "sourceSha256": source_sha256,
        "resultSha256": result_sha256,
        "metrics": {str(key): _finite_or_none(value) for key, value in metrics.items()},
        "findings": clean_findings,
    }
