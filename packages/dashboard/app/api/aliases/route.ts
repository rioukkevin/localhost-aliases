import { createAliasAndSync, listAliases } from "../../../lib/service.ts";
import { readJson, route } from "../../../lib/http.ts";

export const dynamic = "force-dynamic";

export const GET = route(async () => ({ aliases: await listAliases() }));

export const POST = route(async (request: Request) => {
  const result = await createAliasAndSync(await readJson(request));
  return Response.json(result, { status: 201, headers: { "cache-control": "no-store" } });
});
