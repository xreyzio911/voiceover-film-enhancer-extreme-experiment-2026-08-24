# Extreme audio analysis worker

This subtree is the isolated, restart-safe analysis service for the Extreme
Experiment. The browser pipeline remains the only broadband and time-varying
gain authority. The worker may return advisory measurements and an optional
repair candidate; it may not return processing instructions or block delivery.

The first TDD checkpoint intentionally contains only executable RED contracts.
Production modules will live in `extreme_worker/` after these tests have been
reviewed and committed as the RED checkpoint.

Run the contracts from this directory:

```powershell
python -m unittest discover -s tests -v
```

The tests specify these production modules:

- `extreme_worker.model_manifest`: immutable, checksum-pinned model inventory.
- `extreme_worker.security`: one-time HMAC upload tickets and opaque job tokens.
- `extreme_worker.job_store`: durable SQLite jobs, leases, cancellation, and retention.
- `extreme_worker.paths`: containment-safe internal artifact paths.
- `extreme_worker.wav_validation`: bounded PCM WAV structural validation.
- `extreme_worker.uploads`: offset-checked, checksum-verified resumable uploads.
- `extreme_worker.origin_policy`: exact allowlist CORS policy.
- `extreme_worker.report_schema`: bounded advisory-only analysis reports.
- `extreme_worker.safe_logging`: structured logs with secret and PII redaction.
- `extreme_worker.capabilities`: an explicit no-gain-authority capability boundary.
- `extreme_worker.app`: the single-service FastAPI entry point.

