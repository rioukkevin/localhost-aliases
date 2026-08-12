import { handle, json } from "../../../../lib/http.ts";
import { parseUpdateAlias, readJsonBody } from "../../../../lib/input.ts";
import { deleteAliasFlow, updateAliasFlow } from "../../../../lib/service.ts";

export const dynamic = "force-dynamic";

/** Next 15 hands route params in as a promise. */
type Context = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Context): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    const input = parseUpdateAlias(await readJsonBody(req));
    const { value, warning } = await updateAliasFlow(id, input);
    return json({ alias: value, warning: warning ?? undefined });
  });
}

export async function DELETE(_req: Request, ctx: Context): Promise<Response> {
  return handle(async () => {
    const { id } = await ctx.params;
    const { value, warning } = await deleteAliasFlow(id);
    return json({ alias: value, warning: warning ?? undefined });
  });
}
