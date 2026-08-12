import { handle, json } from "../../../lib/http.ts";
import { parseCreateAlias, readJsonBody } from "../../../lib/input.ts";
import { createAliasFlow, listAliasViews } from "../../../lib/service.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return handle(async () => json({ aliases: await listAliasViews() }));
}

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const input = parseCreateAlias(await readJsonBody(req));
    const { value, warning } = await createAliasFlow(input);
    return json({ alias: value, warning: warning ?? undefined }, 201);
  });
}
