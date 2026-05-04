# 03 — MCP Server

The Being Worker exposes each Being as an embedded **Model Context Protocol (MCP)** server over Streamable HTTP. Any MCP-capable client (OpenClaw, Cowork, custom agents) can connect and use the Being's full memory and utility toolset without going through higher-level chat APIs.

---

## Connection

**Transport:** Streamable HTTP (MCP spec §4.2)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/mcp` or `/mcp/:beingId` | Send MCP request / invoke tool |
| `GET`  | `/mcp` or `/mcp/:beingId` | Open SSE stream |
| `DELETE` | `/mcp` or `/mcp/:beingId` | Close session |

The server is **stateless** — a fresh `McpServer` instance is created per request (`sessionIdGenerator: undefined`).

---

## Authentication

Pass a Bearer token in the `Authorization` header.

```
Authorization: Bearer <token>
```

Two token types are supported:

| Prefix | Table | Notes |
|--------|-------|-------|
| `bto_` | `oauth_access_tokens` | OAuth access token — `being_id` is embedded in the token. No query param needed. Checked for expiry and revocation. |
| `brt_` | `being_api_tokens` | Being API token — `being_id` must be provided as a path param (`/mcp/:beingId`) or query param (`?being_id=`). |

Both token types are hashed with SHA-256 before database lookup.

### Scope

Tokens may carry a `scope` field. A `read-only` token is restricted:

- Write tools (`update_memory`, `update_notes`, `merge_nodes`, `update_relation`, `trigger_patrol`) are blocked with `403`.
- Read tools (`recall_memory`, `search_history`, `get_context`, `get_current_time`, `recall`) are always permitted.

### Optional LLM API key

Pass `X-LLM-API-Key: <anthropic_key>` to enable LLM-dependent features (patrol consolidation, scene extraction). When omitted, the server falls back to the BYOK key stored in the database; if none is found, LLM steps are skipped.

---

## Tools

### `recall`

> **Call at the start of every turn.** Performs a vector search against memory clusters to surface relevant past memories for the current user message.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `user_message` | `string` | ✅ | The current user message to search against |

**Returns:** A `<memory-recall>` block containing top-3 similar nodes (direct node-level vector search), shuffled as fragments, or an empty message if nothing matched.

**Mechanism:** Embeds `user_message` with `text-embedding-3-small` (1536-dim), calls `match_nodes` RPC, increments `reactivation_count` on returned nodes.

---

### `get_context`

> Call once at session start. Returns the Being's persona definition and memory snapshot.

Takes no parameters.

**Returns JSON with:**

| Field | Description |
|-------|-------------|
| `system_prompt` | Full system prompt (Block 1-A: soul definition, rules, preferences, relationships) |
| `snapshot` | Block 1-B: structured memory snapshot (notes, knowledge, tools, etc.) |
| `metadata.being_id` | Being UUID |
| `metadata.soul_name` | Soul display name |
| `metadata.model_recommendation` | Suggested LLM model (`claude-sonnet-4-6`) |
| `metadata.cache_guidance` | Hints for prompt caching — `system_prompt` is stable; `snapshot` is semi-stable |
| `capability_tools` | Array of `{ name, description }` for `act`-type capabilities registered by connected Bridges |
| `recent_nodes` | Up to 5 recently activated memory nodes as plain text |

---

### `recall_memory`

Explore memory clusters or individual nodes. Without `cluster_id`, returns the cluster list. With `cluster_id`, returns the cluster digest and its top nodes. With `node_id`, returns the details of a single node.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cluster_id` | `string` (UUID) | — | Omit to list all clusters |
| `node_id` | `string` (UUID) | — | Specify to get a single node's details (cluster_id not needed) |
| `limit` | `number` | — | Max nodes to return (default 5) |
| `query` | `string` | — | Keyword filter applied to node `action` field |
| `no_nodes` | `boolean` | — | Return digest only, no nodes |

**Returns:** Plain text listing of clusters or a cluster's digest + nodes.

**Dead-node revival:** Accessing a dead node increments its `reactivation_count` by 2, making it eligible for revival at next patrol.

---

### `search_memory`

Vector search across `memory_nodes` without needing a cluster ID. Falls back to keyword search when `OPENAI_API_KEY` is not set.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | ✅ | Search query — embedded as vector when API key available, otherwise keyword match |
| `limit` | `number` | — | Max results (default 10, max 30) |
| `mode` | `string` | — | `"or"` (default) or `"and"` — applies to keyword fallback only |

**Returns:** Matched nodes formatted as scene text lines. Result header indicates whether vector or keyword search was used.

---

### `merge_nodes`

Merge multiple similar memory nodes into one.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_ids` | `string` | ✅ | Comma-separated node UUIDs to merge |
| `summary` | `string` | ✅ | The merged node's `action` text |
| `feeling` | `string` | — | Feeling/emotion for the merged node |

**Returns:** Confirmation with new node ID.

**Side effect:** Recomputes the cluster's embedding vector after merging.

---

### `update_memory`

Read and write structured partner memory (preferences, knowledge, relationships, notes, etc.).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target` | enum | ✅ | One of: `preferences`, `knowledge`, `relationship`, `partner_tools`, `partner_map`, `diary`, `notes`, `party_message`, `partner_rules`, `souls` |
| `action` | enum | ✅ | One of: `get`, `append`, `update`, `delete` |
| `content` | `string` | — | Content for `append`/`update` operations |
| `key` | `string` | — | Narrows `update`/`delete`/`get` to a specific entry |
| `location` | `string` | — | Location field for `partner_map` upserts |
| `to` | `string` | — | Recipient partner name (for `party_message` only) |

**Returns:** JSON result of the operation.

---

### `update_notes`

Record conversation scenes and free-form notes. Scenes are converted to `memory_nodes` during patrol; notes persist as-is.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | `'append' \| 'update'` | — | Default `append`. `update` deletes `scene_ids` first, then inserts new scenes |
| `scenes` | `Scene[]` | — | Array of structured scene objects (see below). At least one of `scenes` or `notes` required |
| `notes` | `string[]` | — | Free-form memo strings (TODOs, reminders). Not consumed by patrol |
| `scene_ids` | `string[]` | — | IDs of existing scenes to delete when `action=update` |

**Scene object schema:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | `string` | ✅ | What happened |
| `actors` | `string[]` | ✅ | Who was involved |
| `when` | `string[]` | ✅ | Date(s) in `YYYY-MM-DD` format |
| `setting` | `string` | — | Where / context |
| `feeling` | `string` | — | Subjective first-person impression |
| `themes` | `string[]` | — | Theme tags |
| `importance` | `number` | — | 0.0–1.0 (default 0.5) |

**Auto-patrol trigger:** When accumulated `scene`-type notes reach ≥ 10, patrol is automatically fired in the background.

---

### `search_history`

Search past conversation messages by keyword and/or date range.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | — | Partial-match keyword |
| `date_from` | `string` | — | Start date `YYYY-MM-DD` (inclusive, from 00:00:00 UTC) |
| `date_to` | `string` | — | End date `YYYY-MM-DD` (inclusive, until 23:59:59 UTC) |
| `limit` | `number` | — | Max results (default 10, max 50) |

**Returns:** Formatted list of matching messages with timestamps.

---

### `update_relation`

Manage the Being's entity relationships table.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entity_name` | `string` | ✅ | Name/identifier of the related entity |
| `relation_type` | `string` | ✅ | Entity category: `person`, `device`, `ai`, `organization`, etc. |
| `content` | `string` | — | Description of the relationship (required for `upsert`) |
| `action` | `'upsert' \| 'delete'` | ✅ | Create/overwrite or remove |

**Returns:** JSON operation result.

---

### `trigger_patrol`

Manually invoke the patrol pipeline from a message history.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `messages` | `Array<{role, content}>` | ✅ | Messages to process (pass `[]` to process existing scene notes only) |
| `marker_id` | `string` | — | Previous patrol marker ID |

**Returns JSON:**

```json
{
  "status": "ok",
  "scenes_created": 3,
  "nodes_created": 2,
  "marker_id": "<uuid>"
}
```

When no LLM API key is available (header or DB), steps ❹ and ❻ (Sonnet consolidation/split) are skipped.

---

### `get_current_time`

Returns the current datetime in the specified timezone.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timezone` | `string` | — | IANA timezone identifier, e.g. `Asia/Tokyo` (default: `UTC`) |

**Returns JSON:**
```json
{ "datetime": "2026/04/14（火） 16:30:00", "iso": "2026-04-14T07:30:00.000Z", "timezone": "Asia/Tokyo" }
```

---

## OpenClaw mcpServers Configuration

```json
{
  "mcpServers": {
    "my-being": {
      "url": "https://worker.ruddia.com/mcp/<being_id>",
      "headers": {
        "Authorization": "Bearer brt_xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

For OAuth tokens the `being_id` does not need to be in the URL:

```json
{
  "mcpServers": {
    "my-being": {
      "url": "https://worker.ruddia.com/mcp",
      "headers": {
        "Authorization": "Bearer bto_xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

## Cowork Connection Example

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "cowork-agent", version: "1.0.0" });

const transport = new StreamableHTTPClientTransport(
  new URL("https://worker.ruddia.com/mcp/<being_id>"),
  {
    requestInit: {
      headers: { Authorization: "Bearer brt_xxxxxxxxxxxxxxxx" },
    },
  }
);

await client.connect(transport);

// Retrieve persona and snapshot at session start
const ctx = await client.callTool({ name: "get_context", arguments: {} });

// Per-turn: recall relevant memories before responding
const memories = await client.callTool({
  name: "recall",
  arguments: { user_message: userInput },
});
```
