# Post-b7 VO Stability Adjustment

## Checklist

- [x] Read the two attached review/proposal texts and classify each recommendation against exact repo behavior and corpus evidence.
- [x] Reject unproven word-scale compressor/AGC, stronger limiter drive, fixed house curve, and broad tail/release changes where the evidence was broadband/LF or otherwise under-specified.
- [x] Add advisory-only absolute drift, 180-3000 Hz body-spike, and intra-run body-spread diagnostics so broadband cleanup artifacts are separated from actual voiced-body instability.
- [x] Improve runtime batch volume stability by planning batch alignment from speech-weighted energy measured from bounded, distributed windows of the actual final WAV blobs, while keeping existing true-peak and positive-headroom safety validation.
- [x] Protect private local review corpora with exact root-only ignores for `/bug/` and `/another testing/`.
- [x] Measure all 31 manifest-pinned, exact delivered browser WAV pairs rather than accepting stale in-folder result discovery.
- [x] Run focused tests, full audio-QC suite, TypeScript, lint, production build, security audit, and final deployment/runtime checks after the bounded batch-alignment correction.

## Evidence

- 31/31 manifest-pinned source/delivered-browser pairs measured with 0 errors at `tasks/render-evidence/current-goal/post-b7-adjustment/voice-stability-exact-delivered-v1.json`. Explicit pairs override older files under discovered `result/` folders, including protected recovery outputs.
- Exact delivered corpus medians: candidate absolute drift is less downward than source (`-0.0798` versus `-0.1988 dB/min`); processing-delta drift is `+0.0275 dB/min`; body spread improves by `-2.3937 dB`; robust intra-run body spread improves by `-1.2801 dB` at the median and `-0.0375 dB` at P90; expressive-contrast retention P10 is `0.8095`.
- Existing Seth broadband down-spikes were not treated as a planner/tail failure because source/body evidence showed LF cleanup dominance, not voiced-body collapse.
- Remaining worst-decile intra-run results (Antonio `+2.29 dB`, Arthur `+1.84 dB`, Julie `+1.23 dB`, Seth `+0.79 dB`) stay advisory: they are not sufficient evidence for a word-scale compressor, release rewrite, or candidate rejection without a creating-stage diagnosis and level-matched audition.
- PostCSS override bumped to `8.5.25` after `npm audit --omit=dev` found the advisory; audit is now clean.

# Actor Decrescendo and Cinematic Body Recovery

## Checklist

- [x] Read the Hollywood VO contract, processing guidance, prior planner lessons, exact screenshots, private Ethan/Tony source-result pairs, and current dirty Git state.
- [x] Freeze focused gain-planner and voicing-policy tests and capture source-relative baseline measurements without uploading audio.
- [x] Convert the measured cold-onset and intentional-decrescendo defects into failing planner regressions.
- [x] Implement the smallest continuous, source-adaptive correction inside the existing planner; add no hard quality gate or parallel dynamics/tamer stage.
- [x] Strengthen cinematic body only where measured source/output tone evidence supports it, while continuously damping boom, room, echo, and stacked EQ risk.
- [x] Run focused and full verification, then render the exact Ethan and Tony fixtures through the browser-delivered path.
- [x] Compare exact final WAVs to their sources and prior outputs, complete independent review, and approve the scoped experiment for publication only because the evidence supports it.

## Scope Boundaries

- Preserve intentional dramatic decline and actor emphasis; recover only the portion that becomes unintelligible or that the processing path makes worse.
- Protect the first consonant without lifting pre-speech room tone or introducing a blind gain hold.
- Add no hard quality gate, stricter release blocker, compressor, expander, limiter, gate, consonant tamer, ambience, or recursive corrective loop.
- Keep private WAVs and diagnostic artifacts local. Kimi receives only bounded textual findings, never audio bytes.
- Preserve every earlier onset, tail, anti-spike, pause-noise, echo, room, timing, and one-input/one-output fix unless exact evidence proves a conflict.

## Exact Final Evidence

- Root cause: two remaining Ethan word-body losses were short, voiced words sharing the existing `transient-breath` class. Its `target - 3.2 dB` macro bias and paired peak ceiling—not final polish or the consonant tamer—owned the loss.
- The correction keeps the original class and peak ownership. Continuous 180-3000 Hz body power plus periodic voicing can withdraw only existing attenuation, never create positive gain, and raises the transient ceiling by exactly the same recovery amount.
- Exact browser-delivered Ethan recovery: event E1 improves by `+2.4200 dB` (`-6.710` to `-4.290 dB` source-relative body), and E2 by `+3.0126 dB` (`-9.947` to `-6.935 dB`).
- The quiet-onset decoded samples are SHA-identical. Intra-event 20 ms body shape is unchanged within `0.00004 dB`; no new millisecond gain shimmer is present.
- Ethan delivery remains exact at 943.346 seconds / 45,280,608 samples, float32 mono 48 kHz, and `-1.9 dBTP`. Tony contains no transient-body recovery candidates and was rerendered separately through the final browser code path.
- Final Tony delivery remains exact at 1828.700 seconds / 87,777,600 samples, float32 mono 48 kHz, and `-3.3 dBTP`. It aligns with the prior render at zero samples across active windows; 1 ms speech-frame movement is small and coherent (median `+0.019 dB`, P95 `+0.267 dB`, adjacent-delta P95 `0.112 dB`) rather than new gain flutter.
- Tony's final tone reconciliation is one static `-0.70 dB` body-preservation shelf with 4/8/top-octave trims all at `0.00 dB`, so the final shared-credit refinement does not stack another high-frequency cut.
- Genuine HF-heavy and low-passed aperiodic breath controls remain within `0.5 dB` of the legacy plan. Missing body/sample evidence fails soft to the legacy behavior.
- The final pass adds only source-relative, subtractive body/HF reconciliation. The broad body shelf spends shared correction credit at 4/8/top-octave bands instead of stacking, and every delivery limiter is latency compensated. No compressor, expander, gate, extra limiter, new tamer, or hard quality gate was added.
- Kimi K3's highest available `xhigh` review supported paired macro/peak authority and fail-soft behavior. Its proposed fixed labeled-corpus prerequisite was rejected in favor of deterministic breath controls plus exact browser render evidence.

# Final Experimental VO Hardening

## Checklist

- [x] Read the final pre-production review, current project contracts, prior VO lessons, active Git state, and the exact planner/tone/spatial processing paths.
- [x] Freeze the untouched baseline with the complete audio-QC suite.
- [x] Classify the review recommendations against current source instead of treating its thresholds as release gates.
- [x] Add failing regression coverage for extreme phrase-scale dynamics, clean/dry source voicing, future-event pre-duck, and out-of-band micro-dip authority.
- [x] Implement the smallest continuous, source-adaptive corrections without adding a hard quality gate or another dynamics/tamer stage.
- [x] Run focused and full verification, then render the exact long-form bug fixtures and a clean/dry fixture for source-relative diagnostics and level-matched audition.
- [x] Complete independent correctness/audio/security review and prepare only the scoped experiment changes for release.

## Scope Boundaries

- Preserve one input to one output, 48 kHz mono mix-ready delivery, speech timing, emotional contour, consonants, onsets, and tails.
- Add no hard quality gate, fixed release blocker, stricter acceptance threshold, or iterative quality loop; diagnostics remain advisory.
- Do not re-enable the legacy dynaudnorm/compressor/gate/tamer stack after the gain planner.
- Do not add synthetic ambience to clean/dry speech or brighten/warm a source merely to prove that processing occurred.
- Keep private WAV evidence local. Do not upload source or rendered audio to Gemini or another external provider.
- Change and deploy only this experimental project. Do not stage, promote, or modify the stable app.

## Final Review Verdict

- **Keep:** rerender the exact Seth/Simone long-form fixtures; compare source and output phrase levels; retain source-preserving fallback; keep the faster planner-owned path that avoids stacked stateful DSP; use human level-matched audition for subjective quality.
- **Correct:** numeric targets from the review are listening/diagnostic targets, never hard gates. Planner-active cleanup controls need truthful status, but legacy cleanup must not be re-enabled by default. Long-form makeup needs full-stream evidence before positive gain, not sampled-window authority.
- **Reject:** failing a speech-bearing file solely because adaptive planning is unavailable; enforcing fixed LUFS/tilt/drift thresholds; adding another compressor, limiter, gate, consonant tamer, or blind ambience layer.
- **Direction:** separate phrase-scale macro authority from millisecond/local safety, continuously preserve emotional emphasis, protect clean/dry sources from delayed reflections and stacked cinematic EQ, and keep the final source-preserving path as the non-destructive fallback.

## Exact Final Evidence

- Seth browser WAV: 48 kHz mono float, 1013.933313 s, SHA-256 `FF79D0DEA51B668E512CB7B710DBC83E7C39F0668F2C1D320197F31EA47D1891`.
- Matthew/Simone browser WAV: 48 kHz mono float, 963.456729 s, SHA-256 `3BDCAE055786E8C266E9A0CE30229495A5113EA5CF82841EA405750113038FAC`.
- German Angi browser WAV: 48 kHz mono float, 60.000000 s, SHA-256 `A16624DF745CA5B09F2859E5E3FBB0F17A42288017F6DEE7EA61D5B1613AAC1C`.
- Seth's prior 2.38 dB, 12 ms processing-added speech-body V at 331.122 s is absent in the final rerender; the largest remaining processing-added body-band micro-V in the inspected 330.2-331.4 s window is 0.69 dB in a very low-level frame. Whole-file 100 ms max voice/body gain motion is 5.53/5.96 dB with no events at or above 6 dB.
- Matthew's strong voice-band P90-P10 narrows from 17.74 dB to 12.98 dB while retaining zero gain jumps at or above 6 dB.
- German tone movement stays source-relative and modest: maximum body-normalized band delta 1.80 dB; browser evidence reports delayed-reflection blend `0.0/0.0%`.
- Diagnostics are advisory only. Subjective echo, tone, emotional contour, and naturalness still require human level-matched audition of the delivered WAVs.
- Verification: 408 tests passed with 1 intentional skip, TypeScript passed, lint passed with 2 warnings only in the user's untracked diagnostic, and the production build passed with the existing Audio Splitter NFT trace warning.

# Film Enhancer Audio Quality Upgrade

## Checklist

- [x] Read the pasted proposal, project rules, implementation plan, prior lessons, active Git state, and voiceover quality/processing guidance.
- [x] Inventory the complete optimizer path, current DSP ownership, tests, and the 26 source/output WAV pairs without modifying the corpus.
- [x] Freeze the pre-change software baseline with the full audio-QC suite, lint, and production build.
- [x] Capture pre-change source/output metrics for representative clean, roomy/sparse, and long-form fixtures.
- [x] Classify every proposal item as adopt, adapt, defer, or reject from current-tree and audio evidence.
- [x] Add failing regression coverage for the selected measurement and DSP defects.
- [x] Implement the smallest cohesive, reversible audio improvements without adding or tightening any hard quality gate.
- [x] Run focused and full verification, render exact app outputs, compare source-relative metrics, and record the subjective audition boundary.
- [x] Complete independent correctness/audio-policy/security reviews and record the final evidence.

## Scope Boundaries

- Do not modify Audio Splitter-owned files or reintroduce neural speech enhancement.
- Preserve one input to one output, 48 kHz mono mix-ready delivery, and the app's existing integrity/safety behavior.
- Add no new hard quality gates and do not tighten existing thresholds; new quality measurements must remain diagnostic or advisory.
- Do not upload the private voice corpus to an external provider; keep diagnostic and render evidence local and immutable.
- Do not add another broadly acting compressor, limiter, gate, or tamer without proving the creating stage.
- Do not commit, push, or deploy unless the user separately authorizes it.

## Review Notes

- Adopted: speech-selected tone spectrum for tone reference/matching, activity-first sparse spectrum sampling, linear final app polish, and bounded fricative/onset evidence inside the existing planner.
- Adapted after browser evidence: the proposed "disable segment matching when planner active" was too broad. On `Antonio Rossi_Batch1-10_TimR.wav` it exposed quiet-speech collapse, so planner activity is not a veto; existing long-duration segment matching remains available.
- Rejected/deferred: fixed -22.5 house anchor, new stricter quality gates, blind extra tail hold, dynamic de-esser rewrite, full 16-24 band curve, unconditional color/double HPF, neural/enhancement reordering, long-file hard-gate changes, and persistent actor profiles.
- Exact browser outputs saved under `tasks/render-evidence/`: `01-10_Martina_mixready_browser.wav` (normal final-polish path, quiet-speech PASS) and `Antonio_Rossi_Batch1-10_TimR_mixready_browser_rerender.wav` (audibility recovery path, quiet-speech PASS).
- The Martina output's advisory rendered-spike diagnostic still reports four high-contrast groups around 550-552s; they remain below -6.2 dBFS with no clipping and do not become a gate. This unresolved perceptual tradeoff is part of the required level-matched audition.
- Browser verification exposed that post-render corrective review could call Gemini even while source Auto Pilot was default-off. The follow-up now gates source review, post-render review, and the API route behind the same explicit `VO_AI_AUTO_PILOT_ENABLED` opt-in; deterministic corrective directives remain active when it is off. Gemini received filenames plus bounded JSON analysis/profile metrics during those earlier checks, not source or rendered audio bytes; no corpus WAV was uploaded.
- Final verification: 184 tests passed with 1 existing intentional skip, lint passed, the production build passed, and `git diff --check` found no whitespace errors. A live route smoke with Auto Pilot explicitly off returned `503` and `AI audio review is disabled` before provider configuration. The existing Audio Splitter NFT tracing warning remains unchanged.
- `tasks/render-evidence/` is ignored so the two large private proof WAVs stay local and cannot be accidentally committed.
- Subjective audio quality still needs human level-matched listening; this pass verifies local render integrity and objective diagnostics only.

# Emil Design Engineering Frontend Upgrade

## Checklist

- [x] Read the project rules, current implementation plan, prior lessons, active frontend, Git state, and live desktop/mobile baseline.
- [x] Apply all seven Emil Kowalski skills to audit existing motion, find high-conviction opportunities, reject decorative motion, and keep the current layout and palette identity.
- [x] Add a failing frontend contract for layout/palette guardrails, accessible control names, keyboard-reachable uploads, selection semantics, GPU-only progress, and motion preferences.
- [x] Upgrade the shared shell, VO Optimizer, login, and QC Lab semantics/interactions without editing Audio Splitter-owned files.
- [x] Implement only the gated motion opportunities: failure/completion feedback, login loading feedback, QC drag feedback, keyboard-instant tabs, linear transform progress, and targeted reduced motion/transparency.
- [x] Verify keyboard, focus, labels, progress semantics, desktop/mobile/zoom overflow, reduced motion/transparency, interactions, and console state in the rendered app.
- [x] Run the focused contract, full test suite, lint, production build, dependency audit, diff checks, and independent code/design/security reviews.

## Scope Boundaries

- Preserve the existing page/tool layout, responsive breakpoints, dark neutral + gold color scheme, and all audio-processing behavior.
- Do not edit `src/components/AudioTrackSplitter.tsx`, `src/components/AudioTrackSplitter.module.css`, or any Audio Splitter backend/runtime file.
- Use CSS/native platform behavior; do not add a motion or component dependency for simple transitions and semantics.
- Keep core keyboard navigation instant, keep UI motion under 300 ms, animate only compositor-friendly movement, and retain useful non-motion feedback under reduced motion.

## Review Notes

- The RED design contract initially passed 1/6 tests and failed the five intended upgrade areas; the completed contract passes 6/6 and is included in `test:audio-qc`.
- The active home route has named selects/checkboxes, keyboard-focusable upload controls with visible focus, instant Arrow/Home/End tool navigation, and no horizontal overflow at 1440, 920, 560, 390, or 320 CSS pixels.
- A real invalid-WAV forward test reached `Done with warnings`; the alert dialog focused `Understood`, closed with Escape, restored focus to `Run Batch`, and used opacity-only dismissal under reduced motion.
- Desktop and mobile Lighthouse both score 100 for accessibility, best practices, SEO, and agentic browsing. Fresh browser console checks reported zero errors after the forward tests.
- Final verification: 164 tests passed with 1 intentional worker smoke skip, lint passed, the production build passed, and `git diff --check` passed. The existing Audio Splitter NFT tracing warning remains unchanged.
- Instrumented library coverage is 90.01% lines, 92.28% functions, and 76.12% branches. The repository still has no DOM coverage harness, so the TSX/CSS change is covered by the 6/6 source contract plus live interaction, responsive, Lighthouse, and reduced-motion checks rather than a misleading frontend coverage percentage.
- `npm audit --omit=dev` still reports two pre-existing high-severity `sharp@0.34.5`/libvips advisories inherited through `next@16.2.11`; the suggested forced fix is a breaking Next downgrade, so it was not applied in this frontend-only change.
- Independent correctness, design/accessibility, and security re-reviews reported no remaining actionable findings. The unrelated untracked `audio testing/` directory was preserved and is not part of this change set.

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

# Stable Advanced Options And SRT Theme

## Checklist

- [x] Inspect the collapsed/expanded screenshots and trace the layout-shift cause.
- [x] Audit the live SRT Sync theme tokens, bootstrap, persistence, and toggle behavior.
- [x] Add failing contracts for a non-reflowing advanced disclosure and dark-default dual theme.
- [x] Implement the stable advanced-options layer with Escape, outside-click, and focus return.
- [x] Implement the SRT-derived dark theme, persisted light theme, and pre-paint bootstrap.
- [x] Run focused tests, full tests, lint, build, and `git diff --check`.
- [x] Verify desktop and mobile behavior in-browser, including zero surrounding layout movement.
- [x] Complete independent code/accessibility review and record evidence.

## Browser QA Inventory

- Theme: first visit is dark even with a light OS preference; the header toggle changes to light, updates `data-theme`, `color-scheme`, and `theme-color`, persists through reload, and toggles back to dark.
- Disclosure: Advanced opens without moving Source audio, Processing profile, Batch queue, Deliverables, or Activity log; Escape closes and restores trigger focus; an outside click closes it.
- Responsive visual states: inspect dark/collapsed, dark/open, and light/collapsed at 1440px plus the open layer at 920px, 560px, and 390px.
- Fit and resilience: no horizontal overflow, clipped controls, console errors, or awkward layering; rapidly toggle the disclosure and verify an invalid saved theme still falls back to dark.

## Review Notes

- The final design contract passes 9/9; the complete audio-QC suite passes 167 tests with one optional splitter smoke skipped. ESLint, the production Next.js build, and `git diff --check` pass. The build retains the pre-existing Turbopack NFT tracing warning in the audio-splitter route.
- Browser measurement at 1440px, 920px, 560px, and 390px recorded 0 px movement for Source audio, Processing profile, Batch queue, Deliverables, and Activity log when Advanced opened. The layer stayed inside each viewport with no horizontal overflow.
- Escape closes and restores trigger focus, outside click closes, the scroll-contained panel reaches the review controls, and rapid toggling leaves document geometry unchanged.
- A fresh light-OS context still boots dark. Light mode updates `data-theme`, `color-scheme`, and `theme-color`, persists through reload, and invalid storage falls back to dark. Light secondary surfaces use semantic error/warning/log tokens.
- Independent correctness and design/accessibility reviews found no blocking issues. The light faint-text token was darkened to `#647474`, clearing 4.5:1 contrast on the tinted light surfaces.

# Below-Trigger Liquid Glass Advanced Options

## Checklist

- [x] Inspect the supplied screenshot, current disclosure placement, theme tokens, and Aave glass reference.
- [x] Add failing contracts for below-trigger placement, liquid-glass material, theme-specific readability, and transparency fallbacks.
- [x] Implement the out-of-flow panel below its trigger without changing the surrounding layout or color scheme.
- [x] Verify focused tests, the complete suite, lint, build, and `git diff --check`.
- [x] Verify dark and light popovers in-browser at desktop and narrow widths, including placement, contrast, scrolling, Escape, outside click, and zero layout movement.
- [x] Complete an independent correctness/accessibility review and record final evidence.

## Review Notes

- The Aave reference informed a practical cross-browser glass treatment: restrained translucent fill, static blur/saturation, rim and specular highlights, and solid fallbacks instead of a large SVG/WebGL refraction engine.
- The focused contract went red against the above-trigger opaque panel, then passed 10/10 after implementation. The complete suite passed 168 tests with one optional splitter smoke skipped; ESLint, the production build, and `git diff --check` passed. The build retains the existing Turbopack NFT tracing warning in the audio-splitter route.
- Browser QA at 1440 x 1100 and 390 x 844 measured an exact 8 px trigger-to-panel gap, zero movement in Source audio, Processing profile, Batch queue, Deliverables, and Activity log, and no horizontal overflow. The 352 px panel scrolled through all 576 px of overflow to the review controls.
- Dark and light subtle text measured 4.78:1 and 5.29:1 in the brightest plausible glass regions; dense review metadata measured 5.10:1 and 4.59:1. Reduced transparency rendered a solid theme surface with no backdrop filter.
- Escape closed the panel and restored trigger focus, outside click closed it, and six rapid toggles settled closed without console or dev-server errors. Reduced motion removed transform movement while retaining a 150 ms opacity cue.
- Independent reviewers confirmed the theme treatment, accessibility wiring, cross-browser fallback, and desktop visual quality. The layer intentionally covers the lower action/cards while open because that is the user-annotated below-button target region; those controls return immediately on close, and live geometry supplements the static source contract.
# Adaptive Cinematic Stability and Body Upgrade

## Checklist

- [x] Preserve the active dirty worktree, read the repository contracts, map the planner/render/selection paths, and inventory all local VO fixtures.
- [x] Freeze the current software baseline with `npm run test:audio-qc` and identify the 31 practical source/output corpus pairs.
- [x] Build and run one durable all-corpus measurement ledger for slow rise/fall drift, processing-added spikes, speech-body density, and expressive-transient retention.
- [x] Complete the repository-aware Kimi K3 audio-engineering consultation and verify its consequential suggestions against source and tests.
- [x] Run session-only Gemini 3.6 Flash paired-audio auditions at its highest supported thinking level, requesting detailed cinematic/taste and technical DSP feedback on representative affected and control renders.
- [x] Add RED regressions for processing-added trend/spike defects, source-adaptive body recovery, onomatopoeia protection, fail-soft evidence, and soft enhanced-candidate delivery.
- [x] Implement the smallest continuous planner/final-policy correction plus only proven low-risk complexity fixes; add no parallel dynamics stack.
- [x] Evaluate at most five single-hypothesis variants on the same 31-pair corpus, compare each with the accepted best, and stop when the remaining improvement is within measurement noise or risks performance flattening.
- [x] Rerender the complete source corpus through the final app path, verify exact delivered WAVs, run focused/full tests, lint/build/diff checks, and complete independent correctness/audio/security review.

## Final Evidence

- Kimi K3's first max-reasoning review supported symmetric trend balancing, recurrent body-sag recovery, retained expressive/transient authority, lag-compensated metrics, and advisory-only quality comparison. Its bounded final review (`019fc3b0-60de-7662-93d0-9eddfc36a2eb`) returned conditional GO and independently found the same stale protected-state P1 as the code reviewer. That ship gate and the related recovery-label truthfulness issue were subsequently fixed and independently re-reviewed. The adopted changes stayed inside planner/recovery policy instead of adding a parallel dynamics stack.
- Gemini 3.6 Flash high-thinking audition was external/session-only and advisory. Stable conclusions after challenged corrections were that the final Seth variant was preferred and the Rena defects were materially repaired; Tony preference was prompt-sensitive, so objective expressive evidence remained decisive. In the final SIMONE blind pass Gemini swapped the source and damaged-render identities; after the verified mapping was disclosed, it explicitly retracted those claims and judged the final recovery perceptually source-identical and promotion-safe. The failure and corrected conclusion are recorded in `gemini-review/reports/gemini-simone-final-v8.md`. No SDK/runtime/app integration or credential persistence was added, all 27 unique temporary Files API uploads were deleted after the reviews, and the session key was cleared.
- Final recomputed 31-file / 8.55-hour ledger: `tasks/render-evidence/current-goal/voice-stability-final-v7-full.json` measured 31/31 exact source/result pairs with 0 errors. Median old -> final: drift `0.0837 -> 0.0275 dB/min`, upward spike P95 `6.592 -> 3.591 dB`, downward spike P95 `10.224 -> 3.814 dB`, body spread delta `-4.723 -> -2.394 dB`, expressive-retention P10 `0.437 -> 0.810`. Per-file wins: downward spikes `31/31`, upward spikes `29/31`, expression `26/31`, and body-spread preservation `27/31`.
- SIMONE enhanced-linear recovery: the fixed-segmented output consistently showed `ending-damage+end-edge-dip+source-regression`; those findings request one limiter-on, dynamics/EQ/planner/segmentation-off enhanced linear candidate rather than rejecting enhancement or returning raw source. Advisory ranking cannot cancel the valid recovery. Final exact-tree metrics in `simone-exact-final-v8-stability.json` are lag `0 ms`, no processing-added spike events, body fill/spread `0.00/0.00 dB`, and expressive retention `1.00`. Final polish, corrective recursion, scene blend, loudnorm, batch alignment, and residual mutation are excluded from the protected bytes.
- Long-file WASM proof: a 205.0 MiB / 18.7-minute render completed candidate and final sampled QC at `6/6` windows each after clean-worker rotation, with zero bounded-window fallbacks and exact enhanced delivery. `final-browser-proof-v7.json` records hashes and exact app-path evidence.
- Seth remains an advisory tradeoff, not a hard fallback: down-spike P95 improved `21.11 -> 16.05 dB` and body fill improved `0.20 -> 3.42 dB`, while up-spike P95 and expressive retention worsened (`6.57 -> 8.34 dB`, `0.96 -> 0.63`). This did not meet the verified technical-corruption signature, so no broad source-regression cancellation was added.
- Verification: focused recovery/audibility/contract tests passed, `npm run test:audio-qc` passed `464` tests with `1` intentional optional skip, `npx tsc --noEmit --pretty false` passed, ESLint passed with zero errors and two warnings only in an untracked diagnostic script, the production Next.js build passed with the pre-existing Audio Splitter NFT trace warning, and `git diff --check` reported only LF-to-CRLF notices.

## Scope Boundaries

- Preserve intentional actor dynamics, emphatic attacks, sustained exclamations, and onomatopoeias; correct only processing-added motion or source motion that becomes materially less intelligible.
- Use continuous source-relative confidence and bounded gain authority. Add no compressor, gate, dynaudnorm, broad limiter, consonant tamer, neural enhancer, synthetic ambience, or new cloud provider.
- Keep comparison and quality metrics advisory. A technically valid enhanced render remains deliverable even when a rank or quality score is worse; only true render/decode/byte failure, gross timing or duration corruption, erased speech, or peak/clipping safety can block it.
- Preserve one input to one output, exact duration/alignment, consonants, tails, room-noise safety, clean/dry neutrality, private local WAVs, and all Audio Splitter-owned files.
- Treat objective measurements and level-matched human audition as separate evidence. Do not claim subjective naturalness from metrics alone.
- Keep Gemini review external to the product: read the user-supplied key only at call time, persist no credential, add no SDK/runtime/app integration, upload only the explicitly authorized audition pairs, and treat model listening judgments as advisory rather than a delivery gate.

## Measured Search Contract

- Operation: the active planner-owned mix-ready path plus its single static final polish.
- Correctness gate: focused synthetic regressions, exact WAV geometry/peak/speech integrity, then the complete `test:audio-qc` suite.
- Quality metrics: signed section/body trend, processing-added spike contrast/count, speech-body fill/spread, line/sentence stability, and retained source-relative expressive contrast.
- Audition evidence: detailed paired original/enhanced Gemini review of cinematic tone, body, slow drift, sudden up/down motion, breaths, consonants, room continuity, fatigue, and onomatopoeia/emotional authority; keep this in a separate subjective ledger.
- Search budget: baseline plus no more than five explainable single-hypothesis variants; no paid processing beyond the explicitly authorized session-only Gemini audition uploads.
- Promotion: prefer the best measured safe variant only when the corpus improvement repeats, affected-tail behavior improves materially, expressive controls remain within tolerance, and rollback is a localized constant or helper removal.
