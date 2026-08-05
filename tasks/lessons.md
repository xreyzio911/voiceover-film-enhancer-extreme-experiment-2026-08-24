# Lessons

## 2026-08-05 - Delivered Manifests Outrank Discovered Result Folders

- What went wrong: The default corpus discovery paired sources with older files in nearby `result/` folders, producing plausible but stale release metrics even though the exact browser-delivered WAVs had different hashes.
- Rule to prevent it: Pin release measurements to the render manifest and explicit source/result pairs; treat a path match as unverified whenever it does not identify the exact delivered bytes.
- How to verify next time: Compare hashes or manifest paths before measuring, report the exact ledger path, and never carry stale-pair outliers into a DSP decision.

## 2026-08-05 - Separate Broadband Cleanup From Voiced-Body Instability

- What went wrong: Broadband local-contrast spikes can look like severe volume dropouts when the rendered file intentionally removes low-frequency thumps or rumble.
- Rule to prevent it: Keep broadband spike evidence as an artifact lane, but judge voice stability with source-supported 180-3000 Hz body evidence, absolute source/candidate drift, and intra-run body-spread metrics.
- How to verify next time: Reproduce the exact source/result pair, compare body-band and broadband event lanes separately, then render through the app before claiming a DSP change improved delivered audio.

## 2026-08-05 - Batch Alignment Should Follow Speech, Not Room Time

- What went wrong: Whole-file integrated loudness can be biased by long pauses, tails, or room tone, causing batch alignment offsets that do not match perceived dialogue loudness.
- Rule to prevent it: Plan batch alignment from speech-weighted energy measured from the final emitted WAV blob; keep true-peak and positive-gain headroom validation after rendering.
- How to verify next time: Contract-test the measurement source and run a sparse-speech/long-room batch fixture before changing alignment thresholds.

## 2026-07-24 - Judge Micro-Dips In The Speech Body, Not Gain Motion Alone

- What went wrong: A 100 ms source-relative gain jump looked like a new dip even where the output level stayed stable, while a separate 12 ms 180-3000 Hz V was real but hidden inside a broadband emotional impact.
- Rule to prevent it: Use gain motion only as a locator. Confirm a defect against the aligned source and rendered speech-body envelopes at a fine enough hop, then make the creating planner stage use speech-body evidence with a continuous soft spectral offset instead of treating all K-weighted out-of-band energy as voiced-body authority.
- How to verify next time: Keep synthetic RED coverage for future pre-duck and out-of-band bursts, then rerender the exact browser WAV and compare source/output micro-shapes, whole-file dynamics, peaks, timing, and the human level-matched audition boundary.

## 2026-07-22 - Quality Metrics Must Not Become New Hard Gates

- What went wrong: The implementation plan inherited language about preserving hard gates without making the user's current preference explicit, which could be read as permission to add stricter automatic rejection rules.
- Rule to prevent it: For this experimental audio-quality upgrade, add zero new hard quality gates and do not tighten existing thresholds; use new measurements as diagnostics or advisory evidence only.
- How to verify next time: Review every new metric and call site to confirm it cannot newly fail, reject, suppress, or block an output, while leaving pre-existing integrity safeguards unchanged unless removal is separately authorized.

## 2026-07-22 - Verify Popover Direction, Not Only Layout Stability

- What went wrong: The Advanced options layer was made non-reflowing, but it was anchored above its trigger and covered the upper profile selectors instead of opening into the annotated space below.
- Rule to prevent it: Treat overlay direction as an explicit spatial contract alongside no-layout-shift behavior; do not infer that any non-reflowing placement is acceptable.
- How to verify next time: Measure that the open panel's top edge is below the trigger's bottom edge, while the surrounding card and downstream section rectangles remain unchanged at desktop and mobile widths.

## 2026-07-22 - Verify The Experiment Owner Before Authenticated QA

- What went wrong: The isolated deployment was created and its anonymous auth boundary was verified, but the intended experiment owner's email was not present in the code allowlist, blocking authenticated browser QA.
- Rule to prevent it: Before declaring a newly isolated deployment ready for experiments, confirm the intended owner is authorized by the deployed allowlist without copying credentials or access policy from another project implicitly.
- How to verify next time: Add a focused allowlist regression test for the named owner, then complete a live sign-in check on the new domain after deployment.

## 2026-07-03 - Delivered Audio Must Be The Review Artifact

- What went wrong: QC Lab review bundles were built at the per-file review point, but scene blend, loudness export, and batch alignment can still change the delivered WAV bytes afterward.
- Rule to prevent it: Emit a review bundle only when `winner.wav` is the final delivered artifact; otherwise skip the bundle rather than publishing stale review evidence.
- How to verify next time: Trace every output mutation after review-bundle creation, especially blend/loudness/batch paths, and confirm bundle assets are produced from final `OutputEntry` blobs.

## 2026-07-03 - Sparse Spike Controls Need Separate Safety Floors

- What went wrong: The sparse clean-take branch lowered the same `speechSpikeTaming` value used by both the local body-spike shaper and the residual loud-cluster safety pass.
- Rule to prevent it: Keep musical sparse-take relaxation scoped to the local body-relative shaper; keep the residual speech-spike floor active so caller-provided zeroes cannot bypass safety.
- How to verify next time: Cover both a sparse clean take that should not be over-dipped and a sparse over-hot take that still needs residual correction.

## 2026-07-03 - Long-Form Parts Must Commit Atomically

- What went wrong: Long-form chunk exports pushed each part into UI outputs immediately, so a later chunk failure could leave a partial downloadable set for the same source.
- Rule to prevent it: Stage long-form part outputs locally and publish them only after all required chunks and variants pass duration/peak gates.
- How to verify next time: Review long-form export paths for per-part `setOutputs` calls and prefer one final commit per source file.

## 2026-07-02 - Post-Render Directive Semantics

- What went wrong: The post-render Gemini prompt described `adaptiveDirectives` as deltas, but the normalized directive object represents complete bounded values. Treating those as deltas can double-apply corrective moves on top of the active base profile.
- Rule to prevent it: Keep deterministic issue-tag mappings delta-based, but treat AI-returned post-render `adaptiveDirectives` as absolute final settings unless the schema explicitly says otherwise.
- How to verify next time: Add prompt tests for the wording and a focused test that normalized post-render directive values are retained as final values.

## 2026-07-02 - Mixed Metric Snapshot Keys

- What went wrong: Adding `bandSpectrumDb` to the AI review metric snapshot made a numeric metric reducer type-unsafe because the reducer key list still allowed array-valued fields.
- Rule to prevent it: When a snapshot mixes scalar metrics and bounded arrays, keep separate typed key lists for scalar normalization and array normalization.
- How to verify next time: Run `npm run build` after schema/type additions, not just focused Node tests.

## 2026-04-28 - Next Dev Upload Limit

- What went wrong: The Audio Track Splitter route accepted multipart uploads, but Next's proxy body clone limit stayed at the 10 MB default, so WAV batches were truncated before `request.formData()`.
- Rule to prevent it: For any new upload route intended for large media, check the framework-level request body/proxy limit in addition to the route handler logic.
- How to verify next time: Run or simulate an upload larger than the default limit and confirm the route sees a complete multipart body; run `next build` after config changes.

## 2026-04-28 - Demucs Runtime Setup On Windows

- What went wrong: Demucs installed successfully through pip, but `demucs.exe` was placed in a user Scripts folder outside PATH; the Python 3.13 environment also had mismatched `torch` and `torchaudio` versions.
- Rule to prevent it: After adding a CLI-backed ML feature, verify the exact configured command from the app environment, not just package installation success.
- How to verify next time: Run `python.exe -m demucs --help` and import-check `torch`/`torchaudio` before testing the app upload path.

## 2026-04-28 - Demucs Segment Argument

- What went wrong: The app defaulted `AUDIO_SPLITTER_DEMUCS_SEGMENT` to `7.8`, but the installed Demucs CLI expects `--segment` as an integer and rejects decimal values. Changing it to `8` parsed but exceeded HTDemucs' trained maximum of `7.8`.
- Rule to prevent it: Validate and normalize external CLI option values to the exact type accepted by the installed tool and model.
- How to verify next time: Run the configured Demucs command with every configured option on a tiny WAV before processing real media.

## 2026-04-28 - Splitter Progress And Runtime

- What went wrong: A single long POST meant the frontend could not observe backend per-file progress, so the queue showed file 1 while the terminal was already on later files.
- Rule to prevent it: Long-running media jobs need an explicit job/status API or stream; don't rely on a single request/response for multi-file ML work.
- How to verify next time: Run a multi-file batch and confirm the UI active file changes before the ZIP is ready.

## 2026-04-28 - SFX Stem Quality And Output Size

- What went wrong: Deriving SFX from music stems produced a waveform too similar to BGM, and 32-bit float WAV outputs were unnecessarily large.
- Rule to prevent it: If a requested stem is not supported by the selected model, prefer a simpler truthful output contract over heuristic stems that look precise but are not useful.
- How to verify next time: Inspect output count, waveform differences, and bit depth/file size on a real sample before presenting stem separation as production-ready.

## 2026-04-28 - Relative ML Runtime Paths

- What went wrong: The splitter stored `.venv-audio-splitter\Scripts\python.exe` as a relative command, but Node spawned it from each temporary job directory, causing `ENOENT`.
- Rule to prevent it: Resolve local runtime commands, model directories, and worker paths from the project root before passing them to `spawn`.
- How to verify next time: Run the configured backend path through the real API, not only a direct shell command from the repo root.

## 2026-04-28 - Audio Separator Model Cache Directory

- What went wrong: `.env` pointed `AUDIO_SPLITTER_AUDIO_SEPARATOR_MODEL_DIR` to `.audio-separator-models`, but that directory did not exist, so `audio-separator` failed before loading the cached model.
- Rule to prevent it: Create configured model/cache directories in setup scripts and again at runtime before initializing ML libraries.
- How to verify next time: Smoke test with the same model directory configured in `.env`, not only the library's default user cache.
