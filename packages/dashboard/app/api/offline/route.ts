import { readOffline } from "../../../lib/offline.ts";
import { route } from "../../../lib/http.ts";

export const dynamic = "force-dynamic";

/**
 * `GET /api/offline?host=myapp.test` — everything the /offline page shows, in one read.
 *
 * It is polled while the page is open, because the whole point is to notice the dev
 * server coming up while the user is still looking at the page. Read-only: the config,
 * the project folder, and one TCP connect to 127.0.0.1.
 */
export const GET = route(async (request: Request) =>
  readOffline(new URL(request.url).searchParams.get("host")),
);
