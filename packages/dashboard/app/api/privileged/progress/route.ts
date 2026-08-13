import { readProgress } from "../../../../lib/privileged-channel.ts";
import { route } from "../../../../lib/http.ts";

export const dynamic = "force-dynamic";

/** Poll for the answer to one request id. Without an id, describes the last one asked. */
export const GET = route(async (request: Request) => {
  const id = new URL(request.url).searchParams.get("id");
  return readProgress(id ?? undefined);
});
