import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readProjectFile = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

const palette = {
  canvas: "#0b0c0f",
  surface: "#111318",
  "surface-raised": "#171a20",
  "surface-muted": "#0e1014",
  border: "#272b33",
  "border-strong": "#3a404b",
  text: "#f3f4f2",
  "text-subtle": "#a9b0bc",
  "text-faint": "#747d8d",
  accent: "#e6bd63",
  "accent-hover": "#f0ca77",
  "accent-contrast": "#17130b",
  success: "#70d2ae",
  danger: "#ef7c7c",
  focus: "#f0ca77",
} as const;

test("the upgrade preserves the established palette and responsive shell", () => {
  const globals = readProjectFile("src/app/globals.css");
  const appTools = readProjectFile("src/components/AppTools.module.css");
  const voStyles = readProjectFile("src/components/VoLeveler.module.css");

  for (const [token, value] of Object.entries(palette)) {
    assert.match(globals, new RegExp(`--${token}:\\s*${value.replace("#", "\\#")}`));
  }

  assert.match(appTools, /grid-template-columns:\s*minmax\(196px, 228px\) minmax\(0, 1fr\)/);
  assert.match(appTools, /gap:\s*20px/);
  assert.match(appTools, /@media \(max-width: 920px\)/);
  assert.match(appTools, /@media \(max-width: 560px\)/);
  assert.match(voStyles, /@media \(max-width: 1120px\)/);
  assert.match(voStyles, /@media \(max-width: 720px\)/);
  assert.match(voStyles, /@media \(max-width: 480px\)/);
});

test("core VO controls have names, keyboard access, and disclosure semantics", () => {
  const source = readProjectFile("src/components/VoLeveler.tsx");
  const styles = readProjectFile("src/components/VoLeveler.module.css");

  for (const id of [
    "loudness-target",
    "smart-voice-match",
    "breath-control",
    "leveler-mode",
  ]) {
    assert.match(source, new RegExp(`htmlFor="${id}"`));
    assert.match(source, new RegExp(`id="${id}"`));
  }

  assert.match(source, /className=\{styles\.visuallyHiddenInput\}/);
  assert.match(styles, /\.visuallyHiddenInput\s*\{/);
  assert.match(styles, /:has\(\.visuallyHiddenInput:focus-visible\)/);
  assert.match(source, /<label className=\{styles\.toggleRow\}>/);
  assert.match(source, /aria-controls="advanced-processing-options"/);
  assert.match(source, /id="advanced-processing-options"/);
});

test("queue progress is named, compositor-friendly, and linear", () => {
  const source = readProjectFile("src/components/VoLeveler.tsx");
  const styles = readProjectFile("src/components/VoLeveler.module.css");

  assert.match(source, /role="progressbar"/);
  assert.match(source, /aria-valuemin=\{0\}/);
  assert.match(source, /aria-valuemax=\{100\}/);
  assert.match(source, /aria-valuenow=\{progressPercent\}/);
  assert.match(source, /transform:\s*`scaleX\(\$\{progressPercent \/ 100\}\)`/);
  assert.match(styles, /transition:\s*transform 180ms linear/);
  assert.doesNotMatch(styles, /transition:\s*width\b/);
});

test("delivery help and failure feedback work beyond pointer hover", () => {
  const source = readProjectFile("src/components/VoLeveler.tsx");

  assert.match(source, /data-tooltip=\{outputHelpText\}/);
  assert.match(source, /aria-label=\{`\$\{output\.name\}: \$\{outputHelpText\}`\}/);
  assert.match(source, /aria-label=\{`Download \$\{output\.name\}`\}/);
  assert.match(source, /aria-describedby="failed-description"/);
  assert.match(source, /id="failed-description"/);
  assert.match(source, /onKeyDown=\{handleFailureWarningKeyDown\}/);
  assert.match(source, /ref=\{failureDismissButtonRef\}/);
  assert.match(
    source,
    /const resetFailureWarning = \(\) => \{[\s\S]*?setShowFailureWarning\(false\);[\s\S]*?\n  \};/,
  );
  assert.doesNotMatch(
    source,
    /const resetFailureWarning = \(\) => \{[\s\S]*?\bresetFailureWarning\(\);[\s\S]*?\n  \};/,
  );
});

test("QC review controls expose labels, selection state, and live feedback", () => {
  const source = readProjectFile("src/components/QcReportLab.tsx");
  const styles = readProjectFile("src/components/QcReportLab.module.css");

  assert.match(source, /aria-pressed=\{mode === "analyze"\}/);
  assert.match(source, /aria-pressed=\{mode === "review"\}/);
  assert.match(source, /className=\{styles\.visuallyHiddenInput\}/);
  assert.match(styles, /\.visuallyHiddenInput\s*\{/);
  assert.match(source, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(source, /role="alert"/);
  assert.match(source, /htmlFor=\{confidenceId\}/);
  assert.match(source, /htmlFor=\{reviewerNoteId\}/);
  assert.match(source, /const active = decision\.issueTags\.includes\(tag\)/);
  assert.match(source, /aria-pressed=\{active\}/);
});

test("motion is purposeful, short, and preference-aware", () => {
  const appTools = readProjectFile("src/components/AppTools.module.css");
  const globals = readProjectFile("src/app/globals.css");
  const voStyles = readProjectFile("src/components/VoLeveler.module.css");
  const qcStyles = readProjectFile("src/components/QcReportLab.module.css");
  const loginStyles = readProjectFile("src/components/LoginCard.module.css");
  const styles = [appTools, globals, voStyles, qcStyles, loginStyles].join("\n");

  assert.match(appTools, /\.tab\s*\{[\s\S]*?transition:\s*transform 150ms var\(--ease-out\)/);
  assert.match(globals, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(voStyles, /@media \(prefers-reduced-transparency: reduce\)/);
  assert.match(voStyles, /@starting-style/);
  assert.match(
    voStyles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.warningOverlay\[data-closing="true"\] \.warningCard\s*\{[\s\S]*?transform:\s*none/,
  );
  assert.match(
    voStyles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.outputHint:focus-visible::after,[\s\S]*?\.outputHint:hover::after\s*\{[\s\S]*?transform:\s*none/,
  );
  assert.match(qcStyles, /\.dropzone\s*\{[\s\S]*?transition:\s*border-color 160ms var\(--ease-out\), background 160ms var\(--ease-out\)/);
  assert.match(loginStyles, /\.buttonLabel/);
  assert.doesNotMatch(styles, /transition:\s*all\b/);
  assert.doesNotMatch(styles, /\bease-in\b/);
  assert.doesNotMatch(styles, /scale\(0\)/);
  assert.doesNotMatch(styles, /\b(?:3\d\d|[4-9]\d\d|\d{4,})ms\b/);
});
