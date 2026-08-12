/**
 * One job: turn the persisted config into an `ApplyRequest` and hand it to the
 * privileged helper.
 *
 * It lives on its own rather than inside `service.ts` because three callers need
 * it — `service.ts`, `startup.ts` and `reconcile.ts` — and `reconcile.ts` is itself
 * imported *by* `service.ts`. A shared leaf module is what keeps that from becoming
 * an import cycle.
 *
 * It never throws. The helper is optional infrastructure — it may not be installed
 * at all, which is the normal first-run state — so a failure is reported as a
 * human-readable warning, not raised.
 */
import { buildApplyRequest, buildRoutes, helperApply, issueLeaf, type Config } from "@localhost-aliases/core";
import { errorMessage } from "./errors.ts";

/**
 * Pushes the full desired state to the helper. Returns a warning string instead of
 * throwing, so a mutation that already hit disk still reports success.
 */
export async function pushDesiredState(config: Config): Promise<string | null> {
  let tls: { cert: string; key: string } | null = null;

  if (config.https) {
    try {
      tls = await issueLeaf(buildRoutes(config).map((route) => route.host));
    } catch (error) {
      return `Your changes were saved, but the TLS certificate could not be issued: ${errorMessage(error)}`;
    }
  }

  const result = await helperApply(buildApplyRequest(config, tls));
  if (!result.ok) {
    return `Your changes were saved, but the privileged helper could not be updated: ${result.error}`;
  }
  return null;
}
