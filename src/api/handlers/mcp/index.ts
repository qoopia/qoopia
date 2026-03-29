import { Hono } from 'hono';
import crypto from 'node:crypto';
import { rawDb } from '../../../db/connection.js';
import { resolveActorName } from '../../utils/resolve-actor.js';
import type { AuthContext } from '../../../types/index.js';
import { TOOLS, TOOL_PROFILES, TOOL_PERMISSIONS, handleToolCall } from './registry.js';

const app = new Hono<{ Variables: { auth: AuthContext } }>();

// MCP Streamable HTTP endpoint — full CRUD access to Qoopia data

interface McpRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string };
}

// Store active profile per auth ID (set during initialize)
const sessionProfiles = new Map<string, string>();

function handleToolsList(): unknown {
  return { tools: TOOLS };
}

function checkMcpToolPermission(agentId: string, toolName: string, agentName: string): string | null {
  const required = TOOL_PERMISSIONS[toolName];
  if (!required) return null; // Unknown tool — let handleToolCall return the error

  const [reqEntity, reqAction] = required;

  const agentRow = rawDb.prepare('SELECT permissions FROM agents WHERE id = ? AND active = 1').get(agentId) as { permissions: string } | undefined;
  if (!agentRow) return 'Agent not found or inactive';

  let agentPerms: { rules?: Array<{ entity: string; actions: string[] }> } = {};
  try { agentPerms = JSON.parse(agentRow.permissions); } catch { /* empty perms */ }

  const allowed = (agentPerms.rules || []).some(rule => {
    if (rule.entity !== '*' && rule.entity !== reqEntity && rule.entity !== reqEntity + 's') return false;
    const actions = rule.actions.flatMap((a: string) => a === 'write' ? ['create', 'update', 'delete'] : [a]);
    return actions.includes(reqAction);
  });

  return allowed ? null : `Agent '${agentName}' does not have '${reqAction}' permission for '${reqEntity}'`;
}

// MCP Streamable HTTP POST handler — shared between /mcp and POST /
async function mcpPostHandler(c: any) {
  const auth = c.get('auth') as AuthContext | undefined;
  if (!auth) {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Authentication required' } }, 401);
  }

  // Generate session ID for Streamable HTTP (MCP spec requirement)
  const sessionId = c.req.header('mcp-session-id') || crypto.randomUUID();
  c.header('Mcp-Session-Id', sessionId);

  let body: McpRequest;
  try {
    body = await c.req.json() as McpRequest;
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }

  if (body.jsonrpc !== '2.0' || !body.method) {
    return c.json({ jsonrpc: '2.0', id: body.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
  }

  // Notifications have no id — accept silently (MCP spec)
  if (body.method.startsWith('notifications/')) {
    return c.body(null, 204);
  }

  let result: unknown;

  switch (body.method) {
    case 'initialize': {
      // Detect tool profile from _meta.toolProfile or clientInfo.name pattern "profile:xxx"
      const initParams = body.params as { _meta?: { toolProfile?: string }; clientInfo?: { name?: string } } | undefined;
      let profile = 'full';
      if (initParams?._meta?.toolProfile && initParams._meta.toolProfile in TOOL_PROFILES) {
        profile = initParams._meta.toolProfile;
      } else if (initParams?.clientInfo?.name) {
        const m = initParams.clientInfo.name.match(/profile:(\w+)/);
        if (m && m[1] in TOOL_PROFILES) profile = m[1];
      }
      sessionProfiles.set(auth.id, profile);
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'qoopia', version: '2.0.0' },
      };
      break;
    }

    case 'tools/list': {
      const profile = sessionProfiles.get(auth.id) || 'full';
      const allowed = TOOL_PROFILES[profile];
      if (profile === 'full' || !allowed || allowed.length === 0) {
        result = handleToolsList();
      } else {
        result = { tools: TOOLS.filter(t => allowed.includes(t.name)) };
      }
      break;
    }

    case 'tools/call': {
      const params = body.params as { name: string; arguments?: Record<string, unknown> } | undefined;
      if (!params?.name) {
        return c.json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Missing tool name' } } satisfies McpResponse);
      }
      // Enforce tool profile
      const profile = sessionProfiles.get(auth.id) || 'full';
      const allowed = TOOL_PROFILES[profile];
      if (profile !== 'full' && allowed && allowed.length > 0 && !allowed.includes(params.name)) {
        return c.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Tool not available in current profile. Requested profile: ${profile}` } } satisfies McpResponse);
      }
      // CRITICAL #2: Enforce agent permissions for each MCP tool call
      if (auth.type === 'agent') {
        const permError = checkMcpToolPermission(auth.id, params.name, auth.name);
        if (permError) {
          return c.json({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: permError } } satisfies McpResponse);
        }
      }
      const toolResult = await handleToolCall(params.name, params.arguments || {}, auth.workspace_id, resolveActorName(auth) || 'mcp-user');
      if (toolResult === null) {
        return c.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Unknown tool: ${params.name}` } } satisfies McpResponse);
      }
      result = toolResult;
      break;
    }

    default:
      return c.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `Method not found: ${body.method}` } } satisfies McpResponse);
  }

  return c.json({ jsonrpc: '2.0', id: body.id, result } satisfies McpResponse);
}

app.post('/', mcpPostHandler);

// GET /mcp — SSE stream for MCP Streamable HTTP transport, or server info for discovery
app.get('/', (c) => {
  const accept = c.req.header('Accept') || '';

  // MCP Streamable HTTP: if client asks for SSE, open a keep-alive stream
  if (accept.includes('text/event-stream')) {
    const auth = c.get('auth') as AuthContext | undefined;
    if (!auth) {
      // This shouldn't happen (auth middleware runs before), but safety check
      return c.json({ error: 'Authentication required' }, 401);
    }

    // Return SSE stream — keep connection open for server-initiated notifications
    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          // Send initial keep-alive comment
          controller.enqueue(encoder.encode(': connected\n\n'));

          // Send periodic keep-alive pings (every 30s) to prevent timeout
          const pingInterval = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(': ping\n\n'));
            } catch {
              clearInterval(pingInterval);
            }
          }, 30_000);

          // Clean up on close
          c.req.raw.signal?.addEventListener('abort', () => {
            clearInterval(pingInterval);
            try { controller.close(); } catch { /* already closed */ }
          });
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        },
      },
    );
  }

  // Regular GET — return server info JSON
  return c.json({
    name: 'qoopia',
    version: '2.0.0',
    protocol: 'mcp',
    description: 'Qoopia — Shared Truth Layer for AI Agents (full CRUD MCP access)',
    tools: TOOLS.map(t => t.name),
  });
});

// Exported SSE handler for GET / on the root router (shared logic)
function mcpSseHandler(c: any) {
  const auth = c.get('auth') as AuthContext | undefined;
  if (!auth) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const sessionId = c.req.header('mcp-session-id') || crypto.randomUUID();

  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(': connected\n\n'));

        const pingInterval = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            clearInterval(pingInterval);
          }
        }, 30_000);

        c.req.raw.signal?.addEventListener('abort', () => {
          clearInterval(pingInterval);
          try { controller.close(); } catch { /* already closed */ }
        });
      },
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Mcp-Session-Id': sessionId,
      },
    },
  );
}

export default app;
export { mcpPostHandler, mcpSseHandler };
