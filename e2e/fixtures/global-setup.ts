/** Fresh temp state, then the fake helper. Runs once, before any spec. */
import { startHelper } from "./helper-control";
import { createStateDir } from "./state";

export default async function globalSetup(): Promise<void> {
  createStateDir();
  await startHelper();
}
