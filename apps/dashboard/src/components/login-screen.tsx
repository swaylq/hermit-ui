'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export function LoginScreen({ onSubmit }: { onSubmit: (k: string) => void }) {
  const [key, setKey] = useState('');
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-md p-6 space-y-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">asst dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Enter the machine access key.</p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (key) onSubmit(key);
          }}
          className="space-y-3"
        >
          <Input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoFocus
            placeholder="X-Asst-Key"
            className="font-mono"
          />
          <Button type="submit" disabled={!key} className="w-full">
            sign in
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          Seed first key: <code className="text-foreground">npm run seed</code> in the dashboard directory.
        </p>
      </Card>
    </main>
  );
}
