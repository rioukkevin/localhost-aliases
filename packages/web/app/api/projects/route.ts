import { handle, json } from "../../../lib/http.ts";
import { listProjects } from "../../../lib/service.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return handle(async () => json({ projects: await listProjects() }));
}
