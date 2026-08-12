/**
 * Stops the fake helper. The temp state directory is deliberately left behind:
 * after a failure the config, the hosts file and the apply journal are the first
 * things worth looking at.
 */
import { stopHelper } from "./helper-control";

export default async function globalTeardown(): Promise<void> {
  await stopHelper();
}
