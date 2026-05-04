/**
 * tools.ts — Being MCP Server tool definitions (8 tools)
 *
 * Each tool is a thin wrapper around Being API REST endpoints.
 * Schemas use zod for MCP SDK compatibility.
 *
 * #567
 */

import { z } from "zod"
import { BeingApiClient } from "./api-client.js"

const client = new BeingApiClient()

export type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, z.ZodTypeAny>
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

export const tools: ToolDef[] = [
  // ── recall_memory ───────────────────────────────────────────
  {
    name: "recall_memory",
    description: "Search memory graph for relevant nodes in a specific cluster.",
    inputSchema: {
      cluster_id: z.string().describe("Cluster ID (UUID)"),
      limit: z.number().optional().describe("Max nodes to return (default 5)"),
      query: z.string().optional().describe("Keyword filter for nodes"),
      no_nodes: z.boolean().optional().describe("If true, return digest only"),
    },
    handler: async (args) => client.request("POST", "/memory/recall", args),
  },

  // ── merge_nodes ─────────────────────────────────────────────
  {
    name: "merge_nodes",
    description: "Merge multiple similar memory nodes into one.",
    inputSchema: {
      node_ids: z.string().describe("Comma-separated node IDs to merge"),
      summary: z.string().describe("Summary action text for the merged node"),
      feeling: z.string().optional().describe("Feeling for the merged node"),
    },
    handler: async (args) => client.request("POST", "/memory/merge", args),
  },

  // ── update_memory ───────────────────────────────────────────
  {
    name: "update_memory",
    description:
      "Read/write partner memory (preferences, knowledge, relationship, diary, notes, etc.).",
    inputSchema: {
      target: z
        .string()
        .describe(
          "Target: preferences / knowledge / relationship / partner_tools / partner_map / diary / notes / partner_rules / souls"
        ),
      action: z.string().describe("Operation: get / append / update / delete"),
      content: z.string().optional().describe("Content for append/update"),
      key: z.string().optional().describe("Key filter for update/delete/get"),
    },
    handler: async (args) => client.request("POST", "/memory/update", args),
  },

  // ── conclude_topic ──────────────────────────────────────────
  {
    name: "conclude_topic",
    description:
      "Archive the current topic and save a summary to pinned context.",
    inputSchema: {
      summary: z.string().describe("Topic summary (1-3 sentences)"),
      scenes: z
        .array(z.string())
        .optional()
        .describe("Memorable scenes from this topic"),
    },
    handler: async (args) => client.request("POST", "/memory/conclude", args),
  },

  // ── search_memory ───────────────────────────────────────────
  {
    name: "search_memory",
    description:
      "Search memory nodes (memory_nodes) by keyword across action / feeling / themes / when fields. " +
      "Space-separated terms are OR-searched by default. Use mode='and' to require all terms to match. " +
      "The when field includes evolution history entries ({date, action}) written during consolidation.",
    inputSchema: {
      query: z.string().describe("Search keywords (space-separated for multi-term)"),
      mode: z
        .enum(["or", "and"])
        .optional()
        .describe("Search mode: 'or' (default) or 'and'"),
      limit: z
        .number()
        .optional()
        .describe("Max results (default 10, max 30)"),
    },
    handler: async (args) =>
      client.request("POST", "/memory/search-nodes", args),
  },

  // ── search_history ──────────────────────────────────────────
  {
    name: "search_history",
    description: "Search past conversation history by keyword or date.",
    inputSchema: {
      query: z.string().describe("Search keyword (partial match)"),
      date_from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      date_to: z.string().optional().describe("End date (YYYY-MM-DD)"),
      limit: z
        .number()
        .optional()
        .describe("Max results (default 10, max 50)"),
      session_id: z.string().optional().describe("Session ID filter"),
    },
    handler: async (args) =>
      client.request("POST", "/memory/search-history", args),
  },

  // ── update_relation ─────────────────────────────────────────
  {
    name: "update_relation",
    description:
      "Update relationships with external entities (people, devices, AIs, organizations).",
    inputSchema: {
      entity_name: z.string().describe("Entity name or identifier"),
      relation_type: z
        .string()
        .describe("Entity type: person / device / ai / organization"),
      content: z
        .string()
        .optional()
        .describe("Relationship description (required for upsert)"),
      action: z.string().describe("Operation: upsert / delete"),
    },
    handler: async (args) =>
      client.request("POST", "/relationships/update", args),
  },

  // ── get_current_time ────────────────────────────────────────
  {
    name: "get_current_time",
    description: "Get current time in Asia/Tokyo timezone.",
    inputSchema: {},
    handler: async () => ({
      time: new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
      iso: new Date().toISOString(),
      timezone: "Asia/Tokyo",
    }),
  },

  // ── trigger_patrol ──────────────────────────────────────────
  {
    name: "trigger_patrol",
    description:
      "Run patrol — extract scenes from conversation and generate memory nodes. Requires LLM_API_KEY env var.",
    inputSchema: {
      messages: z
        .array(
          z.object({
            role: z.string(),
            content: z.string(),
          })
        )
        .describe("Conversation messages since last marker ({role, content}[])"),
      marker_id: z
        .string()
        .optional()
        .describe("Previous patrol marker ID (omit for first run)"),
    },
    handler: async (args) =>
      client.request("POST", "/patrol/trigger", args, true),
  },

  // ── remote_exec ─────────────────────────────────────────────
  // #929 — spec 09 (wnbhr/being docs/specs/09-being-remote-exec.md)
  //
  // 露出方針: 常時露出。partner_tools.remote_hosts が未設定の Being では
  // ハンドラがネットワーク呼び出し前に invalid_request を返す。
  //
  // 動的な per-Being 露出（remote_hosts が空のときはツール自体を隠す）が
  // 必要になったら、Being Worker 側に既に GET /v1/beings/:id/remote-exec/has-hosts
  // を生やしてある。MCP サーバー起動時にこれを叩いて、件数 0 のときは本ツールを
  // tools 配列から外す形に切り替えればよい。
  {
    name: "remote_exec",
    description:
      "Execute a shell command on a user-owned remote host (VPS, NAS, home server) over HTTPS. " +
      "Requires a `remote_hosts` entry in partner_tools that lists the host and an auth token. " +
      "If no remote_hosts entry exists for the calling Being, this tool returns an invalid_request error — " +
      "the user must configure partner_tools.remote_hosts first. " +
      "The remote receiver enforces a default-deny allowlist; unauthorised commands return a forbidden error. " +
      "Token values are never returned to the caller.",
    inputSchema: {
      host: z
        .string()
        .describe("host_id from the remote_hosts entry in partner_tools."),
      command: z
        .string()
        .describe(
          "Full command string. Must be authorised by the receiver's allowlist."
        ),
      timeout_ms: z
        .number()
        .optional()
        .describe(
          "Per-call timeout in milliseconds. Receivers may enforce their own upper bound."
        ),
      stdin: z
        .string()
        .optional()
        .describe("Standard input piped to the command. Default empty."),
    },
    handler: async (args) => client.request("POST", "/remote-exec", args),
  },
]

