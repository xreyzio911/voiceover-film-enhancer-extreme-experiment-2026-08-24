import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getServerAuthSession } from "@/auth";
import SignOutButton from "@/components/SignOutButton";
import QcReportLab from "@/components/QcReportLab";
import { isAllowedEmail } from "@/lib/authAllowlist";
import { isLocalHost } from "@/lib/isLocalHost";
import styles from "./page.module.css";

export default async function QcLabPage() {
  const session = await getServerAuthSession();
  const email = session?.user?.email?.toLowerCase();

  if (!isAllowedEmail(email)) {
    redirect("/login");
  }

  const headerStore = await headers();
  const host = headerStore.get("x-forwarded-host") ?? headerStore.get("host");
  if (!isLocalHost(host)) {
    notFound();
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.appHeader}>
          <div className={styles.brandLockup}>
            <span className={styles.brandMark} aria-hidden="true">SP</span>
            <div>
              <div className={styles.brandName}>Shorts Projektt</div>
              <div className={styles.brandContext}>Local QC</div>
            </div>
          </div>
          <div className={styles.navActions}>
            <span className={styles.localBadge}>{email} / Local only</span>
            <Link href="/" className={styles.backLink}>Back to app</Link>
            <SignOutButton className={styles.backLink} />
          </div>
        </header>

        <section className={styles.pageIntro} aria-labelledby="qc-lab-title">
          <h1 id="qc-lab-title" className={styles.title}>QC Lab</h1>
          <p className={styles.subtitle}>
            Check WAV quality and review exported bundles.
          </p>
        </section>

        <QcReportLab />
      </div>
    </main>
  );
}

