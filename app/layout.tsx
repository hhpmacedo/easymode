import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EasyMode",
  description: "Best answer, cheapest capable model. Automatically.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-screen overflow-hidden">{children}</body>
    </html>
  );
}
