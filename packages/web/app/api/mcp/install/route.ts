import { handle, json } from "../../../../lib/http.ts";
import { parseMcpInstall, readJsonBody } from "../../../../lib/input.ts";
import { installMcpClient } from "../../../../lib/service.ts";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handle(async () => {
    const client = parseMcpInstall(await readJsonBody(req));
    return json(await installMcpClient(client));
  });
}
