import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Northline Atlas Dispatch',
  description: 'Tenant ops UI on signed ingest',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
