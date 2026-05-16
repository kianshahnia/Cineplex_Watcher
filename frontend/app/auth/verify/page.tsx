import { Suspense } from "react";

import { Footer } from "../../components/Footer";
import { TopBar } from "../../components/TopBar";
import { VerifyClient } from "./VerifyClient";
import styles from "./VerifyClient.module.css";

export default function VerifyPage(): JSX.Element {
  return (
    <>
      <TopBar />
      <main>
        <Suspense fallback={<VerifyShell />}>
          <VerifyClient />
        </Suspense>
      </main>
      <Footer />
    </>
  );
}

function VerifyShell(): JSX.Element {
  return (
    <section className={`${styles.wrap} container`}>
      <span className={styles.kicker}>Verifying</span>
      <h1 className={styles.title}>
        <span className={styles.spinner} aria-hidden="true" />
        Checking your link
      </h1>
      <p className={styles.body}>One moment — we&apos;re reading your key.</p>
    </section>
  );
}
