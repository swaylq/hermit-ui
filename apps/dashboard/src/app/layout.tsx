import type { Metadata } from 'next';
import './globals.css';
import Providers from './providers';
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { AuthGate } from '@/components/auth-gate';

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: 'asst dashboard',
  description: 'hermit-agent state, tasks, and event inbox',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh" className={cn("h-full antialiased bg-zinc-950 text-zinc-200", "font-sans", geist.variable)}>
      <body className="min-h-full flex flex-col">
        <Providers>
          <AuthGate>{children}</AuthGate>
        </Providers>
      </body>
    </html>
  );
}
