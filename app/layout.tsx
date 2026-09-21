import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jev playground — fixture preview",
  description:
    "Local playground for TypeSafe Jev typed-question scenarios. Fixture responses only; no model is called.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans text-[15px] leading-relaxed">
        {children}
      </body>
    </html>
  );
}
