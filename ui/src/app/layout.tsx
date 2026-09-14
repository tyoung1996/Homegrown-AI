import type { Metadata } from 'next';
import { Fraunces, Inter } from 'next/font/google';
import './globals.css';

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  axes: ['SOFT', 'opsz'],
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body',
});

export const metadata: Metadata = {
  title: 'Circuit Barn',
  description: 'A private AI for your family, running on your own hardware.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
