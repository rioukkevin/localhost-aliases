/**
 * A one-line pub/sub so the fetch layer can tell the status store that whatever
 * it has cached is now stale.
 *
 * It exists only to break an import cycle: `useSystemStatus` reads through
 * `api.ts`, so `api.ts` cannot import it back. Nothing else belongs here.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export function onServerStateChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyServerStateChanged(): void {
  // Copied: a listener is free to unsubscribe itself while being notified.
  for (const listener of [...listeners]) listener();
}
