import { handle, json } from "../../../lib/http.ts";
import { parseSettingsPatch, readJsonBody } from "../../../lib/input.ts";
import { getSettings, updateSettingsFlow } from "../../../lib/service.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return handle(async () => json({ settings: await getSettings() }));
}

export async function PATCH(req: Request): Promise<Response> {
  return handle(async () => {
    const patch = parseSettingsPatch(await readJsonBody(req));
    const { value, warning } = await updateSettingsFlow(patch);
    return json({ settings: value, warning: warning ?? undefined });
  });
}
