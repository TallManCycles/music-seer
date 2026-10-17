import type { Metadata } from "next";
import "./globals.css";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "music-seer",
  description: "Request music, fulfilled by Lidarr with a yt-dlp fallback.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-ink-950 antialiased">
        <Nav />
        {/* pb-24 on phones so the bottom tab bar never covers content. */}
        <main className="mx-auto max-w-6xl px-4 py-6 pb-24 sm:px-5 sm:py-8 sm:pb-8">{children}</main>
      </body>
    </html>
  );
}
