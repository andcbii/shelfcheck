import { createLogRoute } from "@/lib/log-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const route = createLogRoute("shelfcheck-plex", "shelfcheck-plex.log", "No Plex diagnostic scan log is available.");
export const GET = route.GET;
export const DELETE = route.DELETE;
