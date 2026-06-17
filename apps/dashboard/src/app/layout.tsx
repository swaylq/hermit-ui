import type { Metadata, Viewport } from 'next';
import './globals.css';
import Providers from './providers';
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { AuthGate } from '@/components/auth-gate';
import { InstallPrompt } from '@/components/install-prompt';

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: 'asst dashboard',
  description: 'hermit-agent state, sessions, and tasks',
  applicationName: 'asst',
  // Installable-app metadata. The manifest link is auto-injected from app/manifest.ts.
  // statusBarStyle 'black-translucent' makes the iOS status bar transparent so the
  // app's own dark background fills it (seamless — no separate black band). Paired
  // with viewport-fit=cover + safe-area padding on the app shell (see auth-gate).
  appleWebApp: { capable: true, title: 'asst', statusBarStyle: 'black-translucent' },
  icons: { icon: '/favicon.ico', apple: '/apple-touch-icon.png' },
  formatDetection: { telephone: false },
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
  themeColor: '#09090b',
  // Extend the canvas under the iOS status bar / home indicator so the dark app
  // background (not a black band) shows there; the app shell re-insets content via
  // env(safe-area-inset-*) padding so nothing is occluded.
  viewportFit: 'cover',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh" suppressHydrationWarning className={cn("h-dvh overscroll-none antialiased touch-manipulation bg-background text-foreground", "font-sans", geist.variable)}>
      <body className="min-h-full flex flex-col">
        <Providers>
          <AuthGate>{children}</AuthGate>
          <InstallPrompt />
        </Providers>
      </body>
    </html>
  );
}
