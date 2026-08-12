import { handle, json, problem } from "../../../lib/http.ts";
import { readJsonBody } from "../../../lib/input.ts";
import { getOnboarding, markOnboarding, type OnboardingAction } from "../../../lib/onboarding.ts";

export const dynamic = "force-dynamic";

const ACTIONS: OnboardingAction[] = ["complete", "skip", "reset"];

export async function GET(): Promise<Response> {
  return handle(async () => json({ onboarding: await getOnboarding() }));
}

/** `complete` and `skip` both dismiss the flow; `reset` is the "run setup again" button. */
export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const body = await readJsonBody(req);
    const action = body.action as OnboardingAction;
    if (!ACTIONS.includes(action)) {
      return problem("The request could not be validated.", 400, [
        { field: "action", message: `must be one of ${ACTIONS.join(", ")}` },
      ]);
    }
    return json({ onboarding: await markOnboarding(action) });
  });
}
