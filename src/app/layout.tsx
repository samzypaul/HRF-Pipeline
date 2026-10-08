import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HFR Pipeline",
  description: "Tanzania Health Facility Registry: scraping, location checks and weekly reports",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
