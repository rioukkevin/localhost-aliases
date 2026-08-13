import { getState } from "../../../lib/service.ts";
import { route } from "../../../lib/http.ts";

export const dynamic = "force-dynamic";

export const GET = route(async () => getState());
