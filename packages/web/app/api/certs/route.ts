import { handle, json } from "../../../lib/http.ts";
import { generateCA, getCerts } from "../../../lib/certs.ts";

export const dynamic = "force-dynamic";

/** Everything known about the local CA and the leaf it has issued. */
export async function GET(): Promise<Response> {
  return handle(async () => json({ certs: await getCerts() }));
}

/** Creates the CA. Idempotent: an existing CA is returned untouched, never regenerated. */
export async function POST(): Promise<Response> {
  return handle(async () => {
    const { created, certs } = await generateCA();
    return json({ created, certs });
  });
}
