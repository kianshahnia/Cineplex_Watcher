"use client";

import { useEffect, useState } from "react";

import { getMe, logout, type CurrentUser } from "@/lib/api";
import styles from "./TopBar.module.css";

type AuthState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; user: CurrentUser };

/**
 * Right-hand auth control for the TopBar.
 *
 * Renders one of three things based on the current session:
 *  - loading  → a quiet placeholder dot (avoids a layout flash on mount)
 *  - signed-out → a "Sign in" link pointing at the magic-link form
 *  - signed-in  → the user's email + a "Sign out" button
 *
 * Lives in its own client component so the rest of the TopBar can stay a
 * server component.
 */
export function AuthNav(): JSX.Element {
  const [state, setState] = useState<AuthState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const user = await getMe();
        if (!active) return;
        setState(user ? { kind: "signed-in", user } : { kind: "signed-out" });
      } catch {
        if (active) setState({ kind: "signed-out" });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function onSignOut(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await logout();
    } catch {
      // Even if the request fails (e.g. the cookie was already gone), drop
      // the user to the signed-out view — there's nothing useful to retry.
    }
    // Full reload to clear any per-page auth state and land on the homepage.
    window.location.href = "/";
  }

  if (state.kind === "loading") {
    return <span className={styles.authPlaceholder} aria-hidden="true" />;
  }

  if (state.kind === "signed-out") {
    return (
      <a className={styles.link} href="/#members">
        Sign in
      </a>
    );
  }

  return (
    <span className={styles.account}>
      <span className={styles.accountTag}>Signed in</span>
      <span className={styles.accountRule} aria-hidden="true" />
      <span className={styles.accountEmail} title={state.user.email}>
        {state.user.email}
      </span>
      <button
        type="button"
        className={styles.signOut}
        onClick={onSignOut}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </span>
  );
}
