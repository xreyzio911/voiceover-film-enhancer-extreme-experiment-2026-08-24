"use client";

import { useState, type KeyboardEvent } from "react";
import AudioTrackSplitter from "./AudioTrackSplitter";
import VoLeveler from "./VoLeveler";
import styles from "./AppTools.module.css";

type ToolId = "vo-leveler" | "audio-splitter";

const TOOLS: { id: ToolId; label: string; description: string }[] = [
  { id: "vo-leveler", label: "VO Optimizer", description: "Level, review, and export dialogue" },
  { id: "audio-splitter", label: "Audio Splitter", description: "Separate dialogue from a mixed track" },
];

export default function AppTools({ aiAutoPilotEnabled }: { aiAutoPilotEnabled: boolean }) {
  const [activeTool, setActiveTool] = useState<ToolId>("vo-leveler");

  const focusTool = (tool: ToolId) => {
    setActiveTool(tool);
    requestAnimationFrame(() => document.getElementById(`tab-${tool}`)?.focus());
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (index + 1) % TOOLS.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (index - 1 + TOOLS.length) % TOOLS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = TOOLS.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    focusTool(TOOLS[nextIndex].id);
  };

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <nav aria-label="Production tools" className={styles.navigation}>
          <div className={styles.navigationHeader}>
            <span>Workspace</span>
            <span>{TOOLS.length} tools</span>
          </div>
          <div className={styles.tabs} role="tablist" aria-label="Production workspaces" aria-orientation="vertical">
            {TOOLS.map((tool, index) => (
              <button
                key={tool.id}
                id={`tab-${tool.id}`}
                type="button"
                role="tab"
                aria-controls={`panel-${tool.id}`}
                aria-selected={activeTool === tool.id}
                tabIndex={activeTool === tool.id ? 0 : -1}
                className={`${styles.tab} ${activeTool === tool.id ? styles.tabActive : ""}`}
                onClick={() => setActiveTool(tool.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                <span className={styles.tabLabel}>{tool.label}</span>
                <span className={styles.tabDescription}>{tool.description}</span>
              </button>
            ))}
          </div>
          <p className={styles.navigationNote}>
            Switching tools keeps your current files and progress in place.
          </p>
        </nav>
      </aside>

      <div className={styles.workspace}>
        <div
          id="panel-vo-leveler"
          role="tabpanel"
          aria-labelledby="tab-vo-leveler"
          aria-hidden={activeTool !== "vo-leveler"}
          className={styles.toolPanel}
          hidden={activeTool !== "vo-leveler"}
        >
          <h2 className={styles.visuallyHiddenHeading}>VO Optimizer</h2>
          <VoLeveler aiAutoPilotEnabled={aiAutoPilotEnabled} />
        </div>
        <div
          id="panel-audio-splitter"
          role="tabpanel"
          aria-labelledby="tab-audio-splitter"
          aria-hidden={activeTool !== "audio-splitter"}
          className={styles.toolPanel}
          hidden={activeTool !== "audio-splitter"}
        >
          <h2 className={styles.visuallyHiddenHeading}>Audio Splitter</h2>
          <AudioTrackSplitter />
        </div>
      </div>
    </div>
  );
}
