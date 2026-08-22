import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readProjectFile = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

const darkPalette = {
  canvas: "#0d1418",
  surface: "#151f24",
  "surface-raised": "#1b292f",
  "surface-muted": "#10243b",
  border: "#2b383e",
  "border-strong": "#43535a",
  text: "#edf4f4",
  "text-subtle": "#a6b5b5",
  "text-faint": "#849595",
  accent: "#72a8ff",
  "accent-hover": "#94bcff",
  "accent-contrast": "#07111d",
  success: "#5bd6aa",
  danger: "#ff9b90",
  "danger-surface": "#321d1d",
  "danger-border": "#8f4f49",
  "warning-surface": "#292710",
  "warning-border": "#8b7e2c",
  focus: "#94bcff",
} as const;

const lightPalette = {
  canvas: "#ffffff",
  surface: "#f6f8f8",
  "surface-raised": "#ffffff",
  "surface-muted": "#f2f7ff",
  border: "#d7dede",
  "border-strong": "#b9c4c4",
  text: "#091717",
  "text-subtle": "#586767",
  "text-faint": "#647474",
  accent: "#006cff",
  "accent-hover": "#0058d6",
  "accent-contrast": "#ffffff",
  success: "#087a55",
  danger: "#b42318",
  "danger-surface": "#fff4f2",
  "danger-border": "#d48a82",
  "warning-surface": "#fffde3",
  "warning-border": "#e3d226",
  focus: "#006cff",
} as const;

test("the experiment build is unmistakable in the browser tab and primary app copy", () => {
  const layout = readProjectFile("src/app/layout.tsx");
  const page = readProjectFile("src/app/page.tsx");
  const tools = readProjectFile("src/components/AppTools.tsx");

  assert.match(layout, /title:\s*["']Shorts Projektt \| Voiceover Experiment["']/);
  assert.match(page, />Voiceover Experiment<\/h1>/);
  assert.match(page, />Experiment<\/div>/);
  assert.match(tools, /label:\s*["']Voiceover["']/);
  assert.doesNotMatch(page, /Level, review, and export consistent voiceover from one controlled workspace/);
});

test("the SRT-derived theme defaults dark, supports light, and preserves the responsive shell", () => {
  const globals = readProjectFile("src/app/globals.css");
  const appTools = readProjectFile("src/components/AppTools.module.css");
  const voStyles = readProjectFile("src/components/VoLeveler.module.css");

  for (const [token, value] of Object.entries(darkPalette)) {
    assert.match(globals, new RegExp(`--${token}:\\s*${value.replace("#", "\\#")}`));
  }
  assert.match(globals, /:root\[data-theme=["']light["']\]\s*\{/);
  for (const [token, value] of Object.entries(lightPalette)) {
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

test("theme selection is pre-painted, accessible, and persisted", () => {
  const layout = readProjectFile("src/app/layout.tsx");
  const page = readProjectFile("src/app/page.tsx");
  const toggle = readProjectFile("src/components/ThemeToggle.tsx");

  assert.match(layout, /data-theme="dark"/);
  assert.match(layout, /suppressHydrationWarning/);
  assert.match(layout, /voiceover-film-enhancer-theme/);
  assert.match(layout, /meta\[name=["']theme-color["']\]/);
  assert.match(page, /<ThemeToggle\s*\/>/);
  assert.match(toggle, /Use light theme/);
  assert.match(toggle, /Use dark theme/);
  assert.match(toggle, /localStorage\.setItem\(THEME_STORAGE_KEY, nextTheme\)/);
  assert.match(toggle, /document\.documentElement\.dataset\.theme = nextTheme/);
  assert.match(toggle, /meta\?\.setAttribute\("content", themeColor\)/);
});

test("secondary feedback surfaces inherit both themes", () => {
  const voStyles = readProjectFile("src/components/VoLeveler.module.css");
  const loginStyles = readProjectFile("src/components/LoginCard.module.css");
  const splitterStyles = readProjectFile("src/components/AudioTrackSplitter.module.css");
  const qcStyles = readProjectFile("src/components/QcReportLab.module.css");

  assert.match(voStyles, /\.log\s*\{[\s\S]*?color:\s*var\(--text-subtle\)[\s\S]*?background:\s*var\(--surface-muted\)/);
  assert.match(loginStyles, /\.error\s*\{[\s\S]*?color:\s*var\(--danger\)[\s\S]*?background:\s*var\(--danger-surface\)/);
  assert.match(splitterStyles, /\.errorBox\s*\{[\s\S]*?color:\s*var\(--danger\)[\s\S]*?background:\s*var\(--danger-surface\)/);
  assert.match(qcStyles, /\.errorText\s*\{[\s\S]*?color:\s*var\(--danger\)/);
  assert.match(qcStyles, /\.warningBanner\s*\{[\s\S]*?border:\s*1px solid var\(--warning-border\)[\s\S]*?background:\s*var\(--warning-surface\)/);
});

test("advanced processing opens in a stable non-reflowing layer", () => {
  const source = readProjectFile("src/components/VoLeveler.tsx");
  const styles = readProjectFile("src/components/VoLeveler.module.css");

  assert.match(styles, /\.advancedDisclosure\s*\{[\s\S]*?position:\s*relative/);
  assert.match(styles, /\.advancedPanel\s*\{[\s\S]*?position:\s*absolute/);
  assert.match(styles, /\.advancedPanel\s*\{[\s\S]*?max-height:/);
  assert.match(styles, /\.advancedPanel\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(source, /ref=\{advancedDisclosureRef\}/);
  assert.match(source, /ref=\{advancedTriggerRef\}/);
  assert.match(source, /className=\{styles\.advancedPanel\}/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /advancedTriggerRef\.current\?\.focus\(\)/);
});

test("advanced processing opens below its trigger as readable liquid glass", () => {
  const globals = readProjectFile("src/app/globals.css");
  const styles = readProjectFile("src/components/VoLeveler.module.css");
  const darkTheme = globals.match(/:root\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  const lightTheme = globals.match(/:root\[data-theme=["']light["']\]\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
  const advancedPanel = styles.match(/\.advancedPanel\s*\{[\s\S]*?\}/)?.[0] ?? "";

  assert.notEqual(darkTheme, "");
  assert.notEqual(lightTheme, "");
  assert.notEqual(advancedPanel, "");

  for (const token of [
    "glass-panel",
    "glass-border",
    "glass-highlight",
    "glass-sheen",
    "glass-divider",
    "glass-shadow",
  ]) {
    assert.match(darkTheme, new RegExp(`--${token}:`));
    assert.match(lightTheme, new RegExp(`--${token}:`));
  }

  assert.match(advancedPanel, /top:\s*calc\(100% \+ 8px\)/);
  assert.match(advancedPanel, /bottom:\s*auto/);
  assert.doesNotMatch(advancedPanel, /bottom:\s*calc\(100%/);
  assert.match(advancedPanel, /color:\s*var\(--text\)/);
  assert.match(advancedPanel, /border:\s*1px solid var\(--glass-border\)/);
  assert.match(advancedPanel, /background:[\s\S]*?var\(--glass-highlight\)[\s\S]*?var\(--glass-sheen\)[\s\S]*?var\(--glass-panel\)/);
  assert.match(advancedPanel, /-webkit-backdrop-filter:\s*blur\(18px\) saturate\(140%\)/);
  assert.match(advancedPanel, /backdrop-filter:\s*blur\(18px\) saturate\(140%\)/);
  assert.match(advancedPanel, /box-shadow:\s*var\(--glass-shadow\),\s*inset 0 1px 0 var\(--glass-highlight\)/);
  assert.match(advancedPanel, /transform-origin:\s*top center/);
  assert.match(styles, /\.advancedPanel \.toggleRow\s*\{[\s\S]*?border-color:\s*var\(--glass-divider\)/);
  assert.match(styles, /@supports not \(\(backdrop-filter:\s*blur\(1px\)\) or \(-webkit-backdrop-filter:\s*blur\(1px\)\)\)[\s\S]*?\.advancedPanel\s*\{[\s\S]*?background:\s*var\(--surface-raised\)/);
  assert.match(styles, /@media \(prefers-reduced-transparency:\s*reduce\)[\s\S]*?\.advancedPanel\s*\{[\s\S]*?background:\s*var\(--surface-raised\)[\s\S]*?backdrop-filter:\s*none/);
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

test("VO file pickers preserve the selected FileList until ingestion completes", () => {
  const source = readProjectFile("src/components/VoLeveler.tsx");

  assert.match(source, /const resetFileInputBeforeSelection = /);
  assert.equal(source.match(/onClick=\{resetFileInputBeforeSelection\}/g)?.length, 2);
  assert.equal(source.match(/onChange=\{handleFileInputChange\}/g)?.length, 2);
  assert.doesNotMatch(
    source,
    /onChange=\{\(event\) => \{[\s\S]{0,160}?event\.currentTarget\.value = "";/,
  );
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

test("QC review audition is shared, blind by default, and level matched without gain", () => {
  const lab = readProjectFile("src/components/QcReportLab.tsx");
  const audition = readProjectFile("src/components/ReviewAuditionPanel.tsx");
  const helper = readProjectFile("src/lib/reviewAudition.ts");
  const styles = readProjectFile("src/components/QcReportLab.module.css");

  assert.match(lab, /<ReviewAuditionPanel/);
  assert.doesNotMatch(lab, /<audio[\s\S]{0,180}?\bcontrols\b/);
  assert.match(audition, /labelsRevealed[^\n]*useState\(false\)/);
  assert.match(audition, /levelMatchEnabled[^\n]*useState\(true\)/);
  assert.match(audition, /AUDITION_SYNC_TOLERANCE_SECONDS/);
  assert.match(audition, /Math\.abs\(audio\.currentTime - targetTime\)/);
  assert.match(audition, /speechKWeightedEnergyDb/);
  assert.match(audition, /estimatedOffsetSec/);
  assert.match(audition, /resolveAuditionBookmarks/);
  assert.match(audition, /"Reveal labels"/);
  assert.match(helper, /trimDb:\s*Math\.min\(0,/);
  assert.match(styles, /\.auditionPanel\s*\{/);
  assert.match(styles, /\.hiddenAudio\s*\{[\s\S]*?display:\s*none/);
});

test("motion is purposeful, short, and preference-aware", () => {
  const appTools = readProjectFile("src/components/AppTools.module.css");
  const globals = readProjectFile("src/app/globals.css");
  const voStyles = readProjectFile("src/components/VoLeveler.module.css");
  const qcStyles = readProjectFile("src/components/QcReportLab.module.css");
  const loginStyles = readProjectFile("src/components/LoginCard.module.css");
  const themeStyles = readProjectFile("src/components/ThemeToggle.module.css");
  const styles = [appTools, globals, voStyles, qcStyles, loginStyles, themeStyles].join("\n");

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
  assert.match(themeStyles, /@media \(hover: hover\) and \(pointer: fine\)[\s\S]*?\.toggle:hover/);
  assert.doesNotMatch(styles, /transition:\s*all\b/);
  assert.doesNotMatch(styles, /\bease-in\b/);
  assert.doesNotMatch(styles, /scale\(0\)/);
  assert.doesNotMatch(styles, /\b(?:3\d\d|[4-9]\d\d|\d{4,})ms\b/);
});
