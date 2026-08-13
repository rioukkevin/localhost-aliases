import { advanceOnboarding, getOnboarding } from "../../../lib/onboarding.ts";
import { readJson, route } from "../../../lib/http.ts";

export const dynamic = "force-dynamic";

export const GET = route(async () => getOnboarding());

/** `{ action }` advances a step; POST /api/onboarding/:step does the same thing. */
export const POST = route(async (request: Request) => {
  const body = await readJson(request);
  return advanceOnboarding(body.action, body);
});
