import { advanceOnboarding } from "../../../../lib/onboarding.ts";
import { readJson, route } from "../../../../lib/http.ts";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ step: string }>;
}

export const POST = route(async (request: Request, context: Context) =>
  advanceOnboarding((await context.params).step, await readJson(request)),
);
