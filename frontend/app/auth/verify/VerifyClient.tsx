"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ApiError, verifyMagicLink } from "@/lib/api";
import styles from "./VerifyClient.module.css";

type State =
  | { kind: "loading" }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

export function VerifyClient(): JSX.Element {
  const params = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState<State>({ kind: "loading" });
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) {
      return;
    }
    ranRef.current = true;

    if (!token) {
      setState({
        kind: "error",
        message:
          "This link is missing a token. Request a new one from the home page.",
      });
      return;
    }

    void (async () => {
      try {
        const result = await verifyMagicLink(token);
        setState({ kind: "ok", message: result.message });
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : "We couldn't verify that link. It may have expired.";
        setState({ kind: "error", message });
      }
    })();
  }, [token]);

  if (state.kind === "loading") {
    return (
      <section className={`${styles.wrap} container`}>
        <span className={styles.kicker}>Verifying</span>
        <h1 className={styles.title}>
          <span className={styles.spinner} aria-hidden="true" />
          Reading your key
        </h1>
        <p className={styles.body}>One moment — we&apos;re checking the token.</p>
      </section>
    );
  }

  if (state.kind === "ok") {
    return (
      <section className={`${styles.wrap} container`}>
        <span className={styles.kicker}>Welcome back</span>
        <h1 className={styles.title}>
          You&apos;re in.
        </h1>
        <p className={styles.body}>{state.message}</p>
        <Link className={styles.cta} href="/">
          <span>Back to the home page</span>
          <span className={styles.ctaArrow} aria-hidden="true">→</span>
        </Link>
      </section>
    );
  }

  return (
    <section className={`${styles.wrap} ${styles.errorWrap} container`}>
      <span className={`${styles.kicker} ${styles.kickerError}`}>
        Verification failed
      </span>
      <h1 className={styles.title}>That key didn&apos;t work.</h1>
      <p className={styles.body}>{state.message}</p>
      <Link className={styles.cta} href="/">
        <span>Request a new link</span>
        <span className={styles.ctaArrow} aria-hidden="true">→</span>
      </Link>
    </section>
  );
}
