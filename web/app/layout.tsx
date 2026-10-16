import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TMC Document Center",
  description: "Transmare Chemie document library",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#213371",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
