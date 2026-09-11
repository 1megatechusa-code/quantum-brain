import { createMcpHandler } from "agents/mcp";
import type { Env } from "../env";
import { json } from "../lib/http";
import { requireIdentityForMcp } from "../lib/identity";
import { ensureDbReady } from "../runtime/state";
import { buildMcpServer } from "./server";
import { isMcpToolsListRequest, sanitizeToolsListResponse } from "./sanitize";

type McpExecutionContext = ExecutionContext & { props?: { userId?: string } };

const MCP_ROUTE = "/mcp";

/**
 * The customer id in a Quantum Brain connector URL, `/mcp/<id>`, or "" for the
 * bare `/mcp` every pre-billing client uses. Trailing slashes are tolerated;
 * anything deeper than one segment is not a route this handler serves.
 */
export function customerIdFromPath(pathname: string): string | null {
  const trimmed = pathname.replace(/\/+$/, "");
  if (trimmed === MCP_ROUTE) return "";
  if (!trimmed.startsWith(`${MCP_ROUTE}/`)) return null;
  const rest = trimmed.slice(MCP_ROUTE.length + 1);
  return rest && !rest.includes("/") ? rest : null;
}

export function createApiHandler() {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      ensureDbReady(ctx, env);
      const url = new URL(request.url);
      const customerId = customerIdFromPath(url.pathname);
      if (customerId === null) return json({ ok: false, error: "Not found" }, 404);

      const oauthUserId = (ctx as McpExecutionContext).props?.userId;
      const auth = await requireIdentityForMcp(request, env, oauthUserId);
      if (auth instanceof Response) return auth;
      // A connector URL names its customer, and customers.id IS users.id, so the
      // key presented has to be that customer's: a key pasted under someone
      // else's URL is refused without a second lookup. The bare route stays
      // open to every identity, exactly as before billing existed.
      if (customerId && customerId !== auth.userId) {
        return json({ ok: false, error: "Unauthorized", code: "invalid_token" }, 401);
      }

      const server = buildMcpServer(env, ctx, auth);
      const isToolsList = await isMcpToolsListRequest(request);
      // The transport underneath answers 404 to any path but its route, so the
      // customer suffix is stripped before it sees the request.
      let transportRequest = request;
      if (customerId) {
        url.pathname = MCP_ROUTE;
        transportRequest = new Request(url.toString(), request);
      }
      const response = await createMcpHandler(server)(transportRequest, env, ctx);
      return isToolsList ? sanitizeToolsListResponse(response) : response;
    },
  };
}

export const apiHandler = createApiHandler();
