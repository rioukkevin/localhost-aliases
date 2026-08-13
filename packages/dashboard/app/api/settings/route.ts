import { getSettings, updateSettingsAndSync } from "../../../lib/service.ts";
import { readJson, route } from "../../../lib/http.ts";

export const dynamic = "force-dynamic";

export const GET = route(async () => getSettings());

export const PATCH = route(async (request: Request) => updateSettingsAndSync(await readJson(request)));
