import { rescanProject } from "../../../../lib/service.ts";
import { readJson, route } from "../../../../lib/http.ts";

export const dynamic = "force-dynamic";

export const POST = route(async (request: Request) => rescanProject(await readJson(request)));
