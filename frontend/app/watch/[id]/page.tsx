import { notFound } from "next/navigation";

import { Footer } from "../../components/Footer";
import { TopBar } from "../../components/TopBar";
import { ApiError, getShowtimeSeats } from "@/lib/api";
import { WatchError } from "./WatchError";
import { WatchHeader } from "./WatchHeader";
import { WatchInteractive } from "./WatchInteractive";
import styles from "./WatchPage.module.css";

interface PageProps {
  params: { id: string };
}

interface ParsedIds {
  theatre_id: number;
  showtime_id: number;
}

function parseSlug(slug: string): ParsedIds | null {
  const match = /^(\d+)-(\d+)$/.exec(slug);
  if (!match || !match[1] || !match[2]) {
    return null;
  }
  const theatre_id = Number(match[1]);
  const showtime_id = Number(match[2]);
  if (!Number.isFinite(theatre_id) || !Number.isFinite(showtime_id)) {
    return null;
  }
  return { theatre_id, showtime_id };
}

export default async function WatchPage({
  params,
}: PageProps): Promise<JSX.Element> {
  const ids = parseSlug(params.id);
  if (!ids) {
    notFound();
  }

  let data: Awaited<ReturnType<typeof getShowtimeSeats>> | null = null;
  let fetchError: string | null = null;
  try {
    data = await getShowtimeSeats(ids.theatre_id, ids.showtime_id);
  } catch (err) {
    fetchError =
      err instanceof ApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Couldn't reach the box office.";
  }

  return (
    <>
      <TopBar />
      <main className={`${styles.main} container`}>
        {data ? (
          <>
            <WatchHeader data={data} />
            <section className={styles.mapCard} aria-label="Seat map">
              <WatchInteractive initial={data} />
            </section>
          </>
        ) : (
          <WatchError
            message={fetchError ?? "Unknown error."}
            theatreId={ids.theatre_id}
            showtimeId={ids.showtime_id}
          />
        )}
      </main>
      <Footer />
    </>
  );
}
