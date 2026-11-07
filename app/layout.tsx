import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mostrador · AI order-taking with PayPal checkout",
  description: "An AI sales assistant for small shops: it takes the order in chat and gets paid with PayPal inside the conversation. Demo shop is fictional.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
