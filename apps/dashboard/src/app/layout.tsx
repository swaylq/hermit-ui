import type { Metadata, Viewport } from 'next';
import './globals.css';
import Providers from './providers';
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { AuthGate } from '@/components/auth-gate';

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: 'asst dashboard',
  description: 'hermit-agent state, sessions, and tasks',
};

// Lock out user zoom on mobile. userScalable/maximumScale covers Android +
// WKWebView; iOS Safari ignores those, so pinch is also blocked from a client
// effect (gesturestart preventDefault — see Providers) and double-tap via
// `touch-manipulation` on <html>.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh" className={cn("h-dvh overscroll-none antialiased touch-manipulation bg-zinc-950 text-zinc-200", "font-sans", geist.variable)}>
      <body className="min-h-full flex flex-col">
        <Providers>
          <AuthGate>{children}</AuthGate>
        </Providers>
      </body>
    </html>
  );
}
