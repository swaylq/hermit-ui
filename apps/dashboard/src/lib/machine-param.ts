// Which workspace a tap-through belongs to.
//
// Notifications carry a path like `/chat?session=<id>`, and the browser opens it
// on whichever origin sent it. Once one installed PWA can drive several
// dashboard deployments, that path alone is ambiguous: the app might be sitting
// on the OTHER deployment, where that session id does not exist, and the user
// gets an empty chat with no hint why. So every push path also names its
// machine, and the app selects that workspace before its first request.
//
// Deliberately dependency-free: the server (src/server/push) and the browser
// (src/lib/api-base) both use it, so it can pull in neither Prisma nor the
// keyring.

export const MACHINE_PARAM = 'm';

/** Append the owning machine to a notification tap-through path. */
export function withMachine(path: string, machineId: string | null | undefined): string {
  if (!machineId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}${MACHINE_PARAM}=${encodeURIComponent(machineId)}`;
}

/** The machine id in a `?a=b&m=<id>` query string, or null. */
export function machineIdFromSearch(search: string): string | null {
  if (!search) return null;
  try {
    return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search).get(MACHINE_PARAM);
  } catch {
    return null;
  }
}
