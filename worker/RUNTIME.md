# Extreme advisory ML runtime addendum

This runtime measures uploaded WAV sources and, only for the explicit
`enhancement_candidate` scope, may produce one optional source-cleanup candidate. It
never normalizes, compresses, EQs for tone, limits, selects a render candidate, or
changes gain. The browser's `gainPlanner` remains the only broadband and
time-varying level authority. A missing, late, invalid, or failing model produces
`runtimeStatus: degraded` telemetry and empty or unavailable evidence; it does not
block browser delivery.

Uploaded source bytes are deleted immediately after success, failure, or acknowledged
cancellation. Successful advisory reports and successful enhancement candidates
remain available for 24 hours by default, then the SQLite row and fixed per-job
artifacts are purged. The worker accepts at most four active jobs per authenticated
owner by default; a full lane returns HTTP 429 and the browser continues through the
unchanged local path.

Non-terminal work has a separate two-hour stale TTL by default. Upload progress,
state changes, and lease heartbeats refresh job activity. Stale uploading, queued, or
unleased/expired-lease running jobs become `failed`; stale cancellation requests become
`cancelled`. Both expose the bounded `terminalCode: stale_job_expired`, release the
owner's active-job lane, and retry exact fixed-file cleanup after restart. A running or
cancel-requested job with an unexpired lease is never expired by this maintenance pass.

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
subformats, non-finite float samples, and float values outside `[-1, 1]` are rejected
instead of being silently clipped. The runtime parses that header
itself so the Python 3.11 container can handle both the app's 24-bit source files and
its 48 kHz float32 final deliverables. Small payloads are decoded in fixed
65,536-frame chunks into a mono analysis buffer. Longer payloads expose a seekable
mono PCM view instead: Silero consumes a full-duration 16 kHz stream with recurrent
state and 64-sample context preserved across chunks, and DNSMOS/SIGMOS read at most
seven distributed, speech-active 10-second windows. Float validation is also
chunked. This removes the former full mono, float64 resampling-position, and full
16 kHz timeline allocations while keeping all ML active across the whole source.

For every `enhancement_candidate` job, the worker first validates and analyzes the
exact uploaded source with Silero VAD plus the available DNSMOS and SIGMOS models.
That one report is returned even when cleanup cannot produce a usable candidate, so
long-batch orchestration does not need a second source upload and learned evidence is
not lost with the RNNoise result. The browser drains every queued file through two
bounded background lanes and gives each source its own size-aware poll budget; a
late, unavailable, or corrupt result still fails open to the original source.

When the pinned model is available, FFmpeg `arnndn` is attempted for every valid
enhancement source instead of being switched on by a binary noise or speech-quality
threshold. The worker derives a source-relative 10 ms dry/wet curve bounded to
0.012-0.18. Local attacks, high-band consonant energy, aperiodic and short vocal
events, weak-speech breaths, near-silence context, and unusually loud or quiet
moments withdraw the cleanup with an 80 ms protection halo and bounded mix slew.
This is a unity dry/wet blend: it never changes target level or gains authority over
`gainPlanner`.

The filter graph resamples internally to 48 kHz for RNNoise, restores the source
sample rate and channel count, and blends back into the original WAV sample format.
If FFmpeg's RNNoise filter emits trailing padding, the adaptive blend trims only that
tail so the final candidate has the exact source frame count; a short wet file still
fails technical integrity. Only technical integrity can reject the result: unreadable
or non-finite samples, sample-rate/channel/sample-format mismatch, short candidate
audio, introduced clipping, or gross speech erasure. DNSMOS and SIGMOS candidate
deltas are advisory and never select or reject audio. The worker also rechecks the
source SHA-256 after enhancement so the uploaded source remains immutable.

## Immutable model set

The first container includes only commercially permitted, advisory models:

| Component | Immutable revision | SHA-256 | Container |
|---|---|---|---|
| Silero VAD 6.2.1 | `7e30209a3e901f9842f81b225f3e93d8199902b1` | `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3` | bundled |
| DNSMOS P.835 | `27691a53aa069b27be6ac957013d43b3c442da9d` | `269fbebdb513aa23cddfbb593542ecc540284a91849ac50516870e1ac78f6edd` | bundled |
| DNSMOS P.808 | `27691a53aa069b27be6ac957013d43b3c442da9d` | `9246480c58567bc6affd4200938e77eef49468c8bc7ed3776d109c07456f6e91` | bundled |
| SIGMOS P.804 | `33ccd4fca5b8ffe03828530753f0b35769b8e880` | `f939dcc1945055a435565b4369e27dafd0f87df3cea4e2ff6eb81225e52cc53b` | bundled |
| RNNoise `bd.rnnn` | `3eee541a283fd3b8f81b85b1748e3b9ccbefa04d` | `ae3f7411e1e6a884f839a4a145c394408398f09854dbc1216ee02faafc98a17b` | bundled |
| UTMOS | `ff41b8f440cb12ecda18261f9ff7326d058275ce` | `ece7ddb0999d0f12ffe8d7586b3618b8b6fa89269b5152288e4440d686409f69` | optional, not bundled |

The Python package lock uses `--require-hashes`; the container also pins its base
image by digest and verifies every remote model during the Docker build. Runtime model
downloads are disabled with `HF_HUB_OFFLINE=1`. Checksum-pinned upstream MIT notices
for Silero, DNSMOS, and SIGMOS are retained under `/opt/extreme/licenses`. The
RNNoise model data is included from GregorR/rnnoise-models at a pinned commit; that
repository's README states that, aside from its README and tools, the model/data
artifacts are not copyrightable. This is commercially usable enough for the Extreme
experiment, but it is less clean than SPDX-licensed weights because the repository
does not provide a formal license file for `bd.rnnn`.

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

Non-secret runtime defaults (the deployment may override them explicitly):

- `EXTREME_STORAGE_ROOT=/var/data`
- `EXTREME_ML_MODEL_DIR=/opt/extreme/models`
- `EXTREME_ML_METRICS=dnsmos,dnsmos_p808,sigmos`
- `EXTREME_ML_MAX_AUDIO_BYTES=1073741824` (bounded 1 GiB, aligned with the
  browser ticket route and large enough for the exact 30-minute float32 mono corpus
  fixture)
- `EXTREME_ML_MAX_ANALYSIS_SECONDS=2160`
- `EXTREME_ML_RETENTION_SECONDS=86400`
- `EXTREME_ML_STALE_JOB_SECONDS=7200`
- `EXTREME_ML_MAINTENANCE_INTERVAL_SECONDS=300`
- `EXTREME_ML_MAX_ACTIVE_JOBS_PER_OWNER=4`
- `EXTREME_ML_READINESS_TIMEOUT_SECONDS=0.25` (capped at one second per
  SQLite connection attempt)

The service exposes `/health/live` for the container probe and `/health/ready` for
Render. Manifest/production mode requires the separately configured ticket secret
and refuses readiness when it is missing or identical to the internal secret;
deriving it from the internal secret is limited to explicit local/test app
configuration. Readiness performs bounded write-and-rollback probes for both job and
ticket-replay SQLite databases plus an exact create/sync/remove probe in the persistent
storage root. Probe files and rows are not retained. Model failure remains degraded
advisory telemetry and is not a delivery gate.
