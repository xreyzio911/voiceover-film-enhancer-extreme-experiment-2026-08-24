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
