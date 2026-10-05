import type { WorldService } from "./worlds.ts";
import type { AccessService } from "./access.ts";
import type { Push } from "./push.ts";
import type { WorkerClient } from "./worker-client.ts";

/** Shared services handed to the HTTP apps and the MCP server. */
export interface HubServices {
  worlds: WorldService;
  access: AccessService;
  push: Push;
  worker: WorkerClient;
}
