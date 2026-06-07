"use client";

import { useState } from "react";

import { ApiError, requestMagicLink } from "@/lib/api";
import styles from "./EmailLoginCard.module.css";

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "sent"; message: string; verificationUrl?: string }
  | { kind: "error"; message: string };

export function EmailLoginCard(): JSX.Element {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (status.kind === "loading" || email.trim().length === 0) {
      return;
    }
    setStatus({ kind: "loading" });
    try {
      const result = await requestMagicLink(email.trim());
      setStatus({
        kind: "sent",
        message: result.message,
        verificationUrl: result.verification_url,
      });
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : "We couldn't reach the server. Try again in a moment.";
      setStatus({ kind: "error", message });
    }
  }

  const isLoading = status.kind === "loading";

  return (
    <section
      id="members"
      className={`${styles.wrap} container`}
      aria-label="Members — sign in"
    >
      <div className={styles.card}>
        <div className={styles.copy}>
          <span className={styles.kicker}>Members</span>
          <h2 className={styles.title}>
            Save your watches across visits.
          </h2>
          <p className={styles.body}>
            Sign in by email using a single-use link, with no password ever. Your active
            showtimes and notification preferences follow you to any device.
          </p>
          <ul className={styles.bullets}>
            <li>One-tap link, expires in 15 minutes</li>
            <li>Email, SMS, or push for seat alerts</li>
            <li>Manage every watch from your dashboard</li>
          </ul>
        </div>

        <div className={styles.formCol}>
          <form className={styles.form} onSubmit={onSubmit} noValidate>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Email</span>
              <span className={styles.fieldRule} aria-hidden="true" />
              <input
                className={styles.input}
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-label="Email address"
                required
              />
            </div>
            <button
              className={styles.submit}
              type="submit"
              disabled={isLoading || email.trim().length === 0}
              aria-busy={isLoading}
            >
              <span>{isLoading ? "Sending" : "Send link"}</span>
              <span className={styles.submitArrow} aria-hidden="true">
                {isLoading ? "…" : "→"}
              </span>
            </button>
          </form>

          {status.kind === "sent" ? (
            <div className={styles.success} role="status">
              <div className={styles.statusRow}>
                <span className={styles.statusTag}>Sent</span>
                <span>{status.message}</span>
              </div>
              {status.verificationUrl ? (
                <div className={styles.dev}>
                  <span className={styles.devLabel}>Dev mode</span>
                  <a className={styles.devLink} href={status.verificationUrl}>
                    {status.verificationUrl}
                  </a>
                </div>
              ) : null}
            </div>
          ) : null}

          {status.kind === "error" ? (
            <div className={styles.error} role="alert">
              <span className={styles.errorTag}>Error</span>
              <span>{status.message}</span>
            </div>
          ) : null}

          <p className={styles.fineprint}>
            Single use · expires in 15 minutes · no password ever
          </p>
        </div>
      </div>
    </section>
  );
}
