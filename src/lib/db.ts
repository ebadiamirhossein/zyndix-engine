import "server-only";

import { createServiceClient } from "./db/service-client";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

/** App/API code imports this and only this. Cannot be bundled client-side. */
export const db = createServiceClient(url, key);
