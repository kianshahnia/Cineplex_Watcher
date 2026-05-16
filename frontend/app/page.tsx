import { EmailLoginCard } from "./components/EmailLoginCard";
import { Footer } from "./components/Footer";
import { ProcessStrip } from "./components/ProcessStrip";
import { TopBar } from "./components/TopBar";
import { UrlInputCard } from "./components/UrlInputCard";

export default function LandingPage(): JSX.Element {
  return (
    <>
      <TopBar />
      <main>
        <UrlInputCard />
        <ProcessStrip />
        <EmailLoginCard />
      </main>
      <Footer />
    </>
  );
}
