# Authorize Experimental Project Owner

## Checklist

- [x] Trace the live access denial to the shared code allowlist.
- [x] Add a failing regression test for `xreyzio911@gmail.com`.
- [x] Add the email to the shared allowlist and pass focused/full verification.
- [ ] Review, commit, push `main`, and verify the resulting Vercel deployment.

## Assumptions

- This change applies only to the isolated experimental repository and deployment.
- Existing approved accounts must remain authorized.

## Review Notes

- The focused test failed before implementation and passed after adding the owner email.
- Full verification passed with 158 tests plus 1 intentional splitter smoke skip, clean lint, a production build, and zero dependency vulnerabilities.

# Temporarily Remove Manual AI Review UI

## Checklist

- [x] Confirm the highlighted control is the manual AI Review entry point and isolate it from automatic processing integration.
- [x] Add a failing feature-contract test for the absent button/dialog while preserving the backend integration.
- [x] Remove the manual button, dialog lifecycle, markup, and now-unused styles.
- [x] Verify the remaining Run Batch, Clear, and status controls in the rendered app.
- [x] Run the full test, lint, build, diff, and review gates.
- [x] Commit the scoped local change without staging `public/ffmpeg/ffmpeg-core.js`.

## Review Notes

- Scope is intentionally UI-only: the manual AI Review button and modal are temporarily removed. The existing processing pipeline and `/api/audio-review` implementation remain available.
- Chrome QA at `http://localhost:3010/` found zero manual AI Review buttons/dialogs, Run Batch remained disabled with no files, Clear returned the workspace to `Idle`, tool switching preserved the VO workspace, and no console warnings/errors appeared.
- Verification passed with 156 tests plus 1 intentional worker skip, clean lint, a production build, scoped diff checks, and no blockers from independent code/security review. The contract explicitly preserves both source-auto and post-render review call sites.
- `npm audit --omit=dev` continues to report the existing Next.js high advisory plus three moderate transitive advisories; this UI-only change does not modify dependencies or lockfiles.

# Processing Completion Fix and Experimental UI Style Port

## Checklist

- [x] Inspect the supplied stuck-processing screenshot and trace the late batch loudness-alignment FFmpeg reset path.
- [x] Compare the stable UI against the current experimental working-tree UI without modifying the experimental checkout.
- [x] Add focused regression coverage for end-of-stage FFmpeg recycling and generic progress-status updates.
- [x] Fix the late reset/progress state so completed batches settle to Done without unnecessary worker churn.
- [x] Port the experimental design tokens, app shell, tool navigation, cards, login, splitter, and QC styling while preserving stable-only behavior.
- [x] Verify desktop fidelity and interactions in the X Chrome profile, mobile layout at 390 px, and a real two-file completion path in Chrome.
- [x] Run focused tests, `npm run test:audio-qc`, `npm run lint`, `npm run build`, reviews, and scoped diff checks.
- [x] Commit, push `main`, and verify the exact Vercel Production deployment.

## Review Notes

- The experimental checkout is the accepted visual reference. Its runtime/audio changes are explicitly out of scope; only its UI structure and styling are being ported.
- The supplied failure occurs after per-file outputs are ready: the batch-alignment duration guard resets FFmpeg after the last stage item, while the global FFmpeg listener can overwrite finalization copy with generic `Processing NN%`.
- Browser smoke processed two generated 48 kHz WAV files through mix-ready batch alignment: the queue settled at 2 done / 0 active / 0 failed, both outputs appeared, status settled to `Done`, and no post-finalization alignment reset was logged.
- Verification: 155 tests passed with 1 intentional worker skip; focused lifecycle coverage is 100% line/branch/function; lint and production build passed; code and security reviews found no blockers.
- `npm audit` still reports pre-existing dependency advisories (including high findings in Next.js); this change does not modify dependency versions or lockfiles.
- `public/ffmpeg/ffmpeg-core.js` remains a pre-existing modified-looking worktree artifact whose HEAD, index, and worktree hashes are identical. It must not be staged.
- Implementation commit `0d4ae98` reached Vercel `Ready` / `Production` as deployment `5fP8Qp3SF`; the production domain served the updated sign-in surface without browser console errors.

# Stable UI Feature Removal and Auto Pilot Disablement

## Checklist

- [x] Map Keep mix-ready file, Neural Speech Enhancement, and AI Auto Pilot across UI, processing, API, environment, and tests.
- [x] Add or update focused tests for the removed UI, removed neural path, retained mix-ready loudness target, and disabled-by-default backend Auto Pilot.
- [x] Remove the Keep mix-ready file UI/output option while preserving the Mix-ready loudness target.
- [x] Remove Neural Speech Enhancement entirely without touching Audio Track Splitter.
- [x] Remove AI Auto Pilot from the UI; retain its backend capability as optional and disabled by default.
- [x] Run focused tests, `npm run test:audio-qc`, `npm run lint`, `npm run build`, and `git diff --check`.
- [x] Verify the local rendered UI against the supplied reference, then review and commit the scoped diff.
- [x] Push `main` and verify the resulting Production deployment in Vercel using the X Chrome profile.

## Review Notes

- Focused removal/review tests pass 18/18. The full audio-QC suite passes 152 tests with the optional splitter smoke skipped; lint and production build pass.
- Local browser verification in the X Chrome profile confirms the Mix-ready loudness target, Speech-aware leveler, and Cinematic color remain, while Keep mix-ready file, Neural Speech Enhancement, and AI Auto Pilot are absent with no layout gap.
- Local route probes return 404 for removed `/api/neural-repair` and 405 for retained `/api/audio-review` on unsupported GET.
- Independent code and security reviews found no high-severity issues. Two low-level neural residues in lint configuration and stale research guidance were removed and added to the regression contract.
- GitHub `main` and Vercel Production both resolved to `7d6194d`; the X-profile Vercel dashboard reported the deployment Ready.

# End-Spiked-Down Tail Protection

## Checklist

- [x] Read requested `complexity-optimizer` and `oracle` skills, project rules, implementation plan, package scripts, and relevant memory.
- [x] Run whole-codebase complexity scan with generated/vendor/audio folders excluded; inspect the planner/QC/render hot path manually.
- [x] Measure the provided source/output WAVs and screenshots to confirm repeated near-silent output holes inside source-speech tails.
- [x] Run first Oracle planning consult with GPT-5.5 Pro browser mode and reconcile its advice before production edits.
- [x] Add focused gain-planner regression tests for soft spoken tails that fall just outside the detected speech run and close-gap next-run attack overwrite.
- [x] Implement the smallest safe tail-protection fix without touching the audio splitter or enabling neural enhancement.
- [x] Run second Oracle review consult after the patch and address its blocker finding.
- [x] Run `npm run test:audio-qc`, `npm run lint`, and `npm run build`; record verification evidence.

# VO Cinematic Voice Upgrade Review Fixes

## Priority Checklist

- [x] Read the review prompt, original implementation plan/prompt, latest summary, `agent.md`, `tasks/lessons.md`, `package.json`, and required VO code regions.
- [x] Collect uncommitted VO upgrade context and run first Oracle review with the implementation/test context.
- [x] Priority 1: Add the end-edge dip reproducer, split raw vs K-weighted planner domains, calibrate target offset, and verify.
- [x] Run priority 1 verification: `npm run lint`, `npm run build`, `npm run test:audio-qc`.
- [x] Priority 2: Make batch loudness alignment process one file at a time with safe worker recycling.
- [x] Run priority 2 verification: `npm run lint`, `npm run build`, `npm run test:audio-qc`.
- [x] Priority 3: Tighten corrective triggers, add high-value WARN rules and per-batch corrective budget.
- [x] Run priority 3 verification: `npm run lint`, `npm run build`, `npm run test:audio-qc`.
- [x] Priority 4: Remove cold-open metric bias with symmetric edge-trimmed head/body measurement.
- [x] Run priority 4 verification: `npm run lint`, `npm run build`, `npm run test:audio-qc`.
- [x] Priority 5: Make post-render Gemini directives absolute final values while preserving deterministic delta mapping.
- [x] Run priority 5 verification: `npm run lint`, `npm run build`, `npm run test:audio-qc`.
- [x] Run second Oracle review after fixes and apply remaining blockers: delivered review-bundle guard, blend duration authority, sparse spike floor split, severe end-edge gates, and atomic long-form output commit.
- [x] Update `SUMMARY.md` and `tasks/lessons.md`; run final verification and record evidence.

# VO Cinematic Voice Upgrade

## Phase Checklist

- [x] Read `implementation-plan.md`, `agent.md`, `tasks/lessons.md`, package scripts, and load-bearing VO files/ranges.
- [x] Phase 0: Add `coldOpenDipDb` / `coldOpenRiskScore`, AI/review snapshot plumbing, WARN/FAIL review checks, and tests.
- [x] Run phase 0 verification: `npm run lint`, `npm run build`, `npm run test:audio-qc`.
- [x] Phase 1: Fix cold-open planner classification/lift/ramp behavior and add head-primed rendering fallback.
- [x] Run phase 1 verification: `npm run lint`, `npm run build`, `npm run test:audio-qc`.
- [x] Phase 2: Add K-weighted planner loudness, batch loudness alignment, house-tone blend, adaptive de-esser helper, and tests.
- [x] Run phase 2 verification: `npm run lint`, `npm run build`, `npm run test:audio-qc`.
- [x] Phase 3: Add post-render AI review, one bounded corrective pass, widened directives, deterministic fallback mapping, and tests.
- [x] Run phase 3 verification: `npm run lint`, `npm run build`, `npm run test:audio-qc`.
- [x] Phase 4: Run full verification, update `SUMMARY.md`, document verification evidence and listening checks.

# Audio Track Splitter Plan

## Checklist

- [x] Inspect repository structure, upload flow, export logic, and tests.
- [x] Add an isolated `audioSplitterService` with batch processing, validation, report generation, and cleanup-friendly file outputs.
- [x] Add `POST /api/audio-splitter` for authenticated multipart WAV uploads and ZIP export.
- [x] Add an "Audio Track Splitter" tool UI that supports multiple WAV files, queue status, success/failure state, and ZIP download.
- [x] Add focused service tests for single/multiple files, filename rules, unsupported/corrupted files, partial batch failure, ZIP filenames, and aligned durations.
- [x] Update setup docs for the local separation engine.
- [x] Run verification and record results.

## Cleaner Splitter Upgrade

- [x] Add an `audio-separator` RoFormer batch worker that loads the model once per batch.
- [x] Keep Demucs as a configurable fallback engine.
- [x] Export only direct model `BGM`/`VOCAL` WAV stems and default them to 16-bit PCM.
- [x] Surface real-time per-file worker progress through the existing job polling API.
- [x] Update tests for two-stem output, bit depth, batch worker progress, and optional worker smoke coverage.
- [x] Update setup docs and environment examples for the Python 3.12/CUDA audio engine.
- [x] Run splitter tests, lint, and build.

## Assumptions

- The app remains a Next.js app with browser-side VO leveling untouched.
- The splitter backend runs in a Node runtime with filesystem access and a local Demucs CLI installation available for real separation.
- Demucs is used as the first practical local/open-source engine; the drama-specific SFX split is isolated as a replaceable heuristic because Demucs does not directly output an SFX stem.

## Review Notes

- `npm run test:audio-qc` passed (70 tests).
- `npm run lint` passed.
- `npm run build` passed.
- Local dev server started at `http://localhost:3000`.
- Cleaner Splitter upgrade: `npm run test:audio-qc` passed (71 pass, 1 optional worker smoke skipped).
- Cleaner Splitter upgrade: `npm run lint` passed.
- Cleaner Splitter upgrade: `npm run build` passed.
- Cleaner Splitter upgrade: local dev server is running at `http://localhost:3000`; HTTP GET `/` returned 200.
- Local audio engine setup: `.venv-audio-splitter` installed with Python 3.11, CUDA Torch 2.11.0+cu128, `audio-separator`, and `imageio-ffmpeg`.
- Local audio engine setup: RoFormer worker smoke test passed with CUDA and the downloaded model.
