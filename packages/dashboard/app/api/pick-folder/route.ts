import { pickFolder } from "../../../lib/picker.ts";
import { route } from "../../../lib/http.ts";

export const dynamic = "force-dynamic";

export const POST = route(async () => pickFolder());
