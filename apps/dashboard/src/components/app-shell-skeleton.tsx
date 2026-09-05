/**
 * The app's frame, with nothing in it. Rendered by the server and by the client's
 * first commit (they must agree), then replaced the moment the keyring has been
 * read. Pure static markup — no browser APIs, nothing that can differ between the
 * two renders. Shown by Providers (until the tRPC client can be built against the
 * right backend) and by the auth gate (until it knows whether a key exists).
 */
export function AppShellSkeleton() {
  return (
    <div className="flex app-h w-full overflow-hidden bg-background text-foreground pwa-safe-t pwa-safe-x">
      <div className="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar lg:block" />
      <div className="flex-1 min-w-0 min-h-0" />
    </div>
  );
}
