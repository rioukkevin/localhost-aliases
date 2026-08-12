import { handle, json } from "../../../../lib/http.ts";
import { parseLinkProject, readJsonBody } from "../../../../lib/input.ts";
import { linkProject } from "../../../../lib/service.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const { path, aliases } = parseLinkProject(await readJsonBody(req));
    const { value, warning } = await linkProject(path, aliases);
    return json({ ...value, warning: warning ?? undefined });
  });
}
