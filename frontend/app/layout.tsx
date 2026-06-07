import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cinewatcher",
  description:
    "Cinewatcher tracks any Cineplex showtime and pings you the second a seat clears through email, SMS, or push.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): JSX.Element {
  return (
    <html lang="en">
      <body>
        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
