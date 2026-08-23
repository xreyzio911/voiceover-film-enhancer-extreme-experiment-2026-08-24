from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path


class PathViolation(ValueError):
    pass


JOB_ID_RE = re.compile(r"^job_[A-Za-z0-9_-]{1,80}$")


def validate_job_id(job_id: str) -> str:
    if not JOB_ID_RE.fullmatch(job_id):
        raise PathViolation("Invalid job id.")
    return job_id


def _reject_segment(segment: object) -> str:
    text = str(segment)
    path = Path(text)
    if (
        text in {"", "."}
        or "\x00" in text
        or path.is_absolute()
        or re.match(r"^[A-Za-z]:", text)
        or text.startswith("\\\\")
        or "/" in text
        or "\\" in text
        or text == ".."
        or ".." in Path(text).parts
    ):
        raise PathViolation("Path escapes worker storage root.")
    return text


def resolve_under(root: str | Path, *segments: object) -> Path:
    root_path = Path(root).resolve()
    safe_parts = [_reject_segment(segment) for segment in segments]
    candidate = root_path.joinpath(*safe_parts)
    parent = candidate.parent if candidate.suffix else candidate
    if parent.exists() and parent.resolve() != parent.absolute().resolve():
        raise PathViolation("Path contains a redirecting component.")
    resolved = candidate.resolve(strict=False)
    if os.path.commonpath((str(root_path), str(resolved))) != str(root_path):
        raise PathViolation("Path escapes worker storage root.")
    return resolved


@dataclass(frozen=True)
class JobArtifactPaths:
    directory: Path
    upload_part: Path
    source_wav: Path
    report_json: Path


class JobPaths:
    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()

    def for_job(self, job_id: str) -> JobArtifactPaths:
        safe_job_id = validate_job_id(job_id)
        directory = resolve_under(self.root, safe_job_id)
        return JobArtifactPaths(
            directory=directory,
            upload_part=resolve_under(self.root, safe_job_id, "source.upload.part"),
            source_wav=resolve_under(self.root, safe_job_id, "source.wav"),
            report_json=resolve_under(self.root, safe_job_id, "report.json"),
        )


def resolve_job_artifact_path(root: str | Path, job_id: str, filename: str) -> str:
    return str(resolve_under(Path(root), validate_job_id(job_id), filename))
