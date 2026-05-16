import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cinewatcher — Catch the seat the moment it opens.",
  description:
    "Cinewatcher tracks any Cineplex showtime and pings you the second a seat clears — email, SMS, or push. No refreshing required.",
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
