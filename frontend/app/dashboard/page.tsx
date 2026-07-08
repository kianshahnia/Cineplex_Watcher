import { Footer } from "../components/Footer";
import { TopBar } from "../components/TopBar";
import { DashboardClient } from "./DashboardClient";
import styles from "./Dashboard.module.css";

export const metadata = {
  title: "Watchlist — Cinewatch",
};

export default function DashboardPage(): JSX.Element {
  return (
    <>
      <TopBar />
      <main className={`${styles.main} container`}>
        <DashboardClient />
      </main>
      <Footer />
    </>
  );
}
