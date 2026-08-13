import { deleteAliasAndSync, getAliasView, updateAliasAndSync } from "../../../../lib/service.ts";
import { readJson, route } from "../../../../lib/http.ts";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }>;
}

export const GET = route(async (_request: Request, context: Context) => ({
  alias: await getAliasView((await context.params).id),
}));

export const PATCH = route(async (request: Request, context: Context) =>
  updateAliasAndSync((await context.params).id, await readJson(request)),
);

export const DELETE = route(async (_request: Request, context: Context) =>
  deleteAliasAndSync((await context.params).id),
);
