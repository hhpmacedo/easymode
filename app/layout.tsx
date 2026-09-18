import type { Metadata } from "next";
import { Instrument_Sans, Newsreader, Spline_Sans_Mono } from "next/font/google";
import "./globals.css";

const sans = Instrument_Sans({ subsets: ["latin"], variable: "--font-instrument" });
const serif = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-newsreader",
});
const mono = Spline_Sans_Mono({ subsets: ["latin"], variable: "--font-splinemono" });

export const metadata: Metadata = {
  title: "EasyMode",
  description: "Best answer, cheapest capable model. Automatically.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        className={`${sans.variable} ${serif.variable} ${mono.variable} h-screen overflow-hidden`}
      >
        {children}
      </body>
    </html>
  );
}
