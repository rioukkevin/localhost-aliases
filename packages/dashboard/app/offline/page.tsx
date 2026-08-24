import { Suspense } from "react";
import { OfflineLive } from "../../components/offline/OfflineLive.tsx";

export const dynamic = "force-dynamic";

/**
 * `/offline?host=myapp.test`
 *
 * The page the root agent's inline 503 links to. The 503 itself has to be one
 * self-contained response written onto a raw socket, so it can only say the shortest
 * true thing; this is where the rest goes — which alias, which port, the command that
 * starts it, and what to check when the port is right but the bind address is not.
 *
 * `useSearchParams` suspends, so the reading lives behind a boundary rather than opting
 * the whole route out of the App Router's rules.
 */
export default function OfflinePage() {
  return (
    <Suspense fallback={null}>
      <OfflineLive />
    </Suspense>
  );
}
