# Extreme advisory ML runtime addendum

This runtime measures uploaded WAV sources. It never renders, rewrites, repairs,
selects, normalizes, compresses, EQs, limits, or changes gain. The browser's
`gainPlanner` remains the only broadband and time-varying level authority. A missing,
late, invalid, or failing model produces `runtimeStatus: degraded` telemetry and empty
or unavailable evidence; it does not block browser delivery.

Uploaded source bytes are deleted immediately after success, failure, or acknowledged
cancellation. Successful advisory reports remain available for 24 hours by default,
then the SQLite row and fixed per-job artifacts are purged. The worker accepts at most
four active jobs per authenticated owner by default; a full lane returns HTTP 429 and
the browser continues through the unchanged local path.

## App integration

The job executor should create one process-wide runtime and persist its returned JSON:

```python
from extreme_worker.inference import get_runtime

report = get_runtime().analyze_wav(
    source_path,
    job_id=job_id,
    source_sha256=source_sha256,
)
```

`analyze_wav` is serialized through one inference lock. The response has the browser
contract fields `schemaVersion`, `advisoryOnly`, `canBlockDelivery`,
`canChangeGainDb`, `levelAuthority`, `modelSetId`, `source`, `vad`, `metrics`, and
`models`, plus bounded operational `telemetry`. Silero's 32 ms probabilities are
mapped onto contiguous 10 ms report frames so the browser can treat them as
protective evidence adjacent to its existing energy mask. They are not an independent
speech authority. The analysis-duration bound is enforced from validated WAV header
metadata before PCM frames are decoded or allocated; an oversized source returns a
degraded, non-blocking report with its header-derived source facts.

The WAV boundary accepts canonical integer PCM plus 32-bit IEEE float, including
WAVE_FORMAT_EXTENSIBLE only when its subformat GUID matches one of those two formats
and its valid-bit width matches the container. Other float widths, compressed
subformats, and non-finite float samples are rejected. The runtime parses that header
itself so the Python 3.11 container can handle both the app's 24-bit source files and
its 48 kHz float32 final deliverables, and decodes long payloads in fixed
65,536-frame chunks to bound temporary allocation before the mono analysis buffer is
populated.

## Immutable model set

The first container includes only commercially permitted, advisory models:

| Component | Immutable revision | SHA-256 | Container |
|---|---|---|---|
| Silero VAD 6.2.1 | `7e30209a3e901f9842f81b225f3e93d8199902b1` | `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3` | bundled |
| DNSMOS P.835 | `27691a53aa069b27be6ac957013d43b3c442da9d` | `269fbebdb513aa23cddfbb593542ecc540284a91849ac50516870e1ac78f6edd` | bundled |
| DNSMOS P.808 | `27691a53aa069b27be6ac957013d43b3c442da9d` | `9246480c58567bc6affd4200938e77eef49468c8bc7ed3776d109c07456f6e91` | bundled |
| SIGMOS P.804 | `33ccd4fca5b8ffe03828530753f0b35769b8e880` | `f939dcc1945055a435565b4369e27dafd0f87df3cea4e2ff6eb81225e52cc53b` | bundled |
| UTMOS | `ff41b8f440cb12ecda18261f9ff7326d058275ce` | `ece7ddb0999d0f12ffe8d7586b3618b8b6fa89269b5152288e4440d686409f69` | optional, not bundled |

The Python package lock uses `--require-hashes`; the container also pins its base
image by digest and verifies every remote model during the Docker build. Runtime model
downloads are disabled with `HF_HUB_OFFLINE=1`. Checksum-pinned upstream MIT notices
for Silero, DNSMOS, and SIGMOS are retained under `/opt/extreme/licenses`.

NISQA is excluded because its weights are noncommercial. DeepFilterNet is excluded
from this runtime and image because repair is outside the first release and its model
weight terms have not been cleared. The 411 MB UTMOS graph is recognized as a licensed
optional metric but omitted from the first CPU image; requesting it without a verified
local artifact yields unavailable telemetry.

## Deployment boundaries

The root `render.yaml` creates one uniquely named Singapore `standard` web service,
one instance, one 20 GB persistent disk mounted at `/var/data`, and a 300 second
graceful shutdown window. The code and model directories are read-only to the
unprivileged `extreme` user; only persistent state/cache under `/var/data` is writable.
Uvicorn starts one process and the runtime permits one concurrent inference lane.

Configure these values in the isolated Render service:

- `EXTREME_ALLOWED_ORIGINS`: exact Extreme Vercel origin(s), comma-separated.
- `EXTREME_INTERNAL_SECRET`: a unique random secret shared only with the Extreme
  Vercel ticket route.
- `EXTREME_TICKET_SECRET`: a different unique random secret used to sign short-lived
  worker tickets.

All three are `sync: false`; no secret is stored in Git. Do not reuse values from the
current experiment or another Render service.

Non-secret defaults in the Blueprint:

- `EXTREME_STORAGE_ROOT=/var/data`
- `EXTREME_ML_MODEL_DIR=/opt/extreme/models`
- `EXTREME_ML_METRICS=dnsmos,dnsmos_p808,sigmos`
- `EXTREME_ML_MAX_ANALYSIS_SECONDS=2160`
- `EXTREME_ML_RETENTION_SECONDS=86400`
- `EXTREME_ML_MAINTENANCE_INTERVAL_SECONDS=300`
- `EXTREME_ML_MAX_ACTIVE_JOBS_PER_OWNER=4`

The service exposes `/health/live` for the container probe and `/health/ready` for
Render. Readiness must describe API/storage readiness; model failure remains degraded
advisory telemetry and is not a delivery gate.
