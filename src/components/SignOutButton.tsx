"use client";

import { signOut } from "next-auth/react";
import { useState } from "react";

type SignOutButtonProps = {
  className?: string;
};

export default function SignOutButton({ className }: SignOutButtonProps) {
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    if (signingOut) {
      return;
    }

    setSigningOut(true);
    try {
      await signOut({ callbackUrl: "/login" });
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <button
      className={className}
      type="button"
      disabled={signingOut}
      aria-busy={signingOut}
      onClick={handleSignOut}
    >
      {signingOut ? "Signing out…" : "Sign out"}
    </button>
  );
}
