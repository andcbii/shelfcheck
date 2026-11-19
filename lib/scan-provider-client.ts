import "server-only";
import { ProviderClient } from "@/lib/provider-client";
import { scanRuns } from "@/lib/scan-run";

/**
 * The one provider client every Scan run's requests share, so provider
 * deadlines carry from one run to the next. Its log lines and rate-limit
 * pauses reach only the run that dispatched each request.
 */
export const scanProviderClient = new ProviderClient({ run: () => scanRuns.bound() });
