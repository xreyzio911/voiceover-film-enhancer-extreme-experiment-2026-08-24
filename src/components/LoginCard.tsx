"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import styles from "./LoginCard.module.css";

const getErrorText = (error: string | null) => {
  if (error === "AccessDenied") {
    return "This Google account is not allowed to access this app.";
  }
  if (error === "Configuration") {
    return "Google login is not configured.";
  }
  if (error === "SigninRequired") {
    return "Sign in with an approved Google account.";
  }
  if (error === "OAuthAccountNotLinked") {
    return "This account is not linked for access.";
  }
  if (error) {
    return "Login failed. Please try again.";
  }
  return null;
};

export default function LoginCard() {
  const searchParams = useSearchParams();
  const [signingIn, setSigningIn] = useState(false);
  const error = searchParams.get("error");
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";
  const errorText = getErrorText(error);

  const handleSignIn = async () => {
    if (signingIn) {
      return;
    }

    setSigningIn(true);
    try {
      await signIn("google", { callbackUrl });
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <div className={styles.card}>
      <div className={styles.brandLockup}>
        <span className={styles.brandMark} aria-hidden="true">SP</span>
        <div>
          <div className={styles.brand}>Shorts Projektt</div>
          <div className={styles.brandContext}>Voiceover experiment</div>
        </div>
      </div>
      <div className={styles.copy}>
        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.subtitle}>
          Use an approved Google account to open the workspace.
        </p>
      </div>
      {errorText && <div className={styles.error} role="alert">{errorText}</div>}
      <button
        type="button"
        className={styles.button}
        disabled={signingIn}
        aria-busy={signingIn}
        aria-label="Continue with Google"
        data-busy={signingIn ? "true" : "false"}
        onClick={handleSignIn}
      >
        <span
          className={`${styles.buttonLabel} ${styles.buttonLabelIdle}`}
          aria-hidden="true"
        >
          Continue with Google
        </span>
        <span
          className={`${styles.buttonLabel} ${styles.buttonLabelPending}`}
          aria-hidden="true"
        >
          Opening Google
        </span>
      </button>
      <p className={styles.hint}>Approved accounts only.</p>
    </div>
  );
}
