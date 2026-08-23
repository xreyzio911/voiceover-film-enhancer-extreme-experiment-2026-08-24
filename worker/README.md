# Extreme audio analysis worker

This subtree is the isolated, restart-safe analysis service for the Extreme
Experiment. The browser pipeline remains the only broadband and time-varying
gain authority. The worker may return advisory measurements and bounded VAD
evidence; it may not return processing instructions or block delivery.

The production modules in `extreme_worker/` implement the executable contracts
in `tests/`. The service uses one embedded, durable analysis lane per instance.

Run the contracts from this directory:

```powershell
python -m unittest discover -s tests -v
```

The tests specify these production modules:

- `extreme_worker.model_manifest`: immutable, checksum-pinned model inventory.
- `extreme_worker.security`: one-time HMAC upload tickets and opaque job tokens.
- `extreme_worker.job_store`: durable SQLite jobs, leases, cancellation, stale-work
  expiry, and retention.
- `extreme_worker.paths`: containment-safe internal artifact paths.
- `extreme_worker.wav_validation`: bounded integer-PCM/IEEE-float32 WAV structural
  validation.
- `extreme_worker.inference`: checksum-pinned model execution plus bounded decoding
  for integer PCM and IEEE-float32 sources, including their valid
  WAVE_FORMAT_EXTENSIBLE forms.
- `extreme_worker.uploads`: offset-checked, checksum-verified resumable uploads.
- `extreme_worker.origin_policy`: exact allowlist CORS policy.
- `extreme_worker.report_schema`: bounded advisory-only analysis reports.
- `extreme_worker.app`: bounded endpoints, event-only logging, cooperative
  cancellation, exact artifact cleanup, storage/SQLite readiness, and retention.
- `extreme_worker.capabilities`: an explicit no-gain-authority capability boundary.
- `extreme_worker.api_support`: truthful degraded fallback and bounded request
  rate limiting.
