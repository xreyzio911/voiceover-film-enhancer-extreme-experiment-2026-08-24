from __future__ import annotations


def build_capabilities() -> dict[str, object]:
    return {
        "advisoryOnly": True,
        "canBlockDelivery": False,
        "canChangeGainDb": False,
        "levelAuthority": "gainPlanner",
        "supports": ["vad_protection", "quality_metrics", "speaker_similarity", "optional_repair_candidate"],
    }
