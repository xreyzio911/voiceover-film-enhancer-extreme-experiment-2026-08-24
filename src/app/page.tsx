import Link from "next/link";
import { headers } from "next/headers";
import AppTools from "@/components/AppTools";
import SignOutButton from "@/components/SignOutButton";
import ThemeToggle from "@/components/ThemeToggle";
import { getServerAuthSession } from "@/auth";
import { isAllowedEmail } from "@/lib/authAllowlist";
import { isAiAutoPilotEnabled } from "@/lib/aiAutoPilotPolicy";
import { isLocalHost } from "@/lib/isLocalHost";
import { redirect } from "next/navigation";
import styles from "./page.module.css";

export default async function Home() {
  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  const localMode = isLocalHost(host);
  const session = localMode ? null : await getServerAuthSession();
  const email = localMode ? "local developer" : session?.user?.email?.toLowerCase();

  if (!localMode && !isAllowedEmail(email)) {
    redirect("/login");
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.appHeader}>
          <div className={styles.brandLockup}>
            <span className={styles.brandMark} aria-hidden="true">SP</span>
            <div>
              <div className={styles.brandName}>Shorts Projektt</div>
              <div className={styles.brandContext}>Extreme Experiment</div>
            </div>
          </div>
          <div className={styles.headerActions}>
            {localMode && (
              <Link href="/qc-lab" className={styles.utilityLink}>
                QC Lab
              </Link>
            )}
            <ThemeToggle />
            <div className={styles.accountBlock}>
              <span className={styles.accountLabel}>{localMode ? "Local session" : "Signed in"}</span>
              <span className={styles.account}>{email}</span>
            </div>
            {!localMode && <SignOutButton className={styles.logoutButton} />}
          </div>
        </header>

        <section className={styles.pageIntro} aria-labelledby="workspace-title">
          <div className={styles.introCopy}>
            <h1 id="workspace-title" className={styles.title}>Extreme Experiment</h1>
            <p className={styles.subtitle}>
              Level and check voiceover with the Extreme test pipeline.
            </p>
          </div>
          <dl className={styles.specs} aria-label="Workspace specifications">
            <div>
              <dt>Format</dt>
              <dd>48 kHz float</dd>
            </div>
            <div>
              <dt>QC</dt>
              <dd>Final checks</dd>
            </div>
            <div>
              <dt>Workflow</dt>
              <dd>Batch</dd>
            </div>
          </dl>
        </section>
        <AppTools aiAutoPilotEnabled={isAiAutoPilotEnabled(process.env.VO_AI_AUTO_PILOT_ENABLED)} />
      </div>
    </main>
  );
}
