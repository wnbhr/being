# 08 — Extensions

## Concept

Extensions are optional add-ons that attach extra capabilities to a specific Being. They follow an **addon pattern**: installing or uninstalling an extension has no effect on the Being's core behaviour. The base chat loop, memory, and MCP server all work identically whether extensions are present or not.

Each extension is a record in the `extensions` table (global catalog) linked to a Being via `being_extensions`. The `being_extensions` row stores whether the extension is active (`is_active`) and its per-Being configuration (`config` JSONB).

---

## Extension Store

### List available extensions

```
GET /v1/extensions
Authorization: Bearer <token>
```

Returns all extensions where `is_active=true`, ordered by creation date:
```json
[
  { "id": "...", "slug": "telegram", "name": "Telegram BYOB", "description": "..." },
  { "id": "...", "slug": "tool-loop", "name": "Tool Loop", "description": "..." },
  { "id": "...", "slug": "sandbox", "name": "Sandbox", "description": "..." }
]
```

### Get extension detail

```
GET /v1/extensions/:slug
Authorization: Bearer <token>
```

Returns the extension including its `config_schema`.

---

## Per-Being Extension Endpoints

All endpoints below require `Authorization: Bearer <brt_...>` and verify that `being_id` belongs to the authenticated user.

### List installed extensions

```
GET /v1/beings/:being_id/extensions
```

Returns the `being_extensions` rows with joined extension metadata.

### Install an extension

```
POST /v1/beings/:being_id/extensions/:slug/install
```

Upserts a `being_extensions` row with `is_active=true`.

**Subscription gate:** `tool-loop` and `sandbox` extensions require an active Stripe subscription (`subscriptions` table, `status='active'`). If no active subscription is found, the server returns `403`:
```json
{ "error": "tool-loop 拡張はサブスクリプションが必要です。購読を開始してからインストールしてください。" }
```

### Uninstall an extension

```
DELETE /v1/beings/:being_id/extensions/:slug/uninstall
```

Deletes the `being_extensions` row. Returns `204 No Content`.

### Toggle active state

```
PUT /v1/beings/:being_id/extensions/:slug/toggle
```

Flips `is_active` between `true` and `false`. Returns the updated row.

### Update configuration

```
PUT /v1/beings/:being_id/extensions/:slug/config
Content-Type: application/json

{ "bot_token": "123456:ABC...", "llm_api_key": "sk-ant-..." }
```

Merges the request body into the existing `config` JSONB. For the `telegram` slug, sensitive fields receive special handling (see Telegram section below). For other extensions, fields are stored as-is.

---

## Extension Types

### Telegram BYOB

Brings-Your-Own-Bot: connect a Being to a Telegram bot you create yourself via BotFather.

**Setup flow:**

1. Create a bot in Telegram with [@BotFather](https://t.me/BotFather). Copy the bot token.
2. Install the extension:
   ```
   POST /v1/beings/:being_id/extensions/telegram/install
   ```
3. Configure the bot token and optionally an LLM API key:
   ```
   PUT /v1/beings/:being_id/extensions/telegram/config
   { "bot_token": "7123456789:AAF...", "llm_api_key": "sk-ant-..." }
   ```
   On this call, the server:
   - AES-encrypts the token and stores it as `bot_token_encrypted` in `config`.
   - Generates a 16-byte random `webhook_secret`.
   - Calls `https://api.telegram.org/bot<token>/setWebhook` with:
     - `url`: `<PUBLIC_URL>/v1/extensions/telegram/webhook/<being_id>`
     - `secret_token`: the generated webhook secret.
4. The Being is now reachable on Telegram.

**Webhook endpoint (no auth required from Telegram):**

```
POST /v1/extensions/telegram/webhook/:being_id
X-Telegram-Bot-Api-Secret-Token: <webhook_secret>
```

The server validates `X-Telegram-Bot-Api-Secret-Token` against `config.webhook_secret`. Invalid tokens return `403`.

**Bot commands:**

| Command | Effect |
|---------|--------|
| `/new` | Saves scenes via `update_notes`, runs patrol, then deletes all `being_id`-scoped `chat_messages`. Starts a fresh context. |
| `/compact` | Saves scenes via `update_notes`, then deletes chat messages (no patrol). |
| `/stop` | Sets `telegram_sessions.is_active=false`. The Being stops responding until `/new`. |
| `/reset` | Deletes chat messages without saving. Hard reset. |

**Model support:** The Telegram extension supports multi-provider LLMs. The model is read from `config.model` (default `claude-sonnet-4-6`). The provider is inferred from the model name prefix (`gpt`/`o1`/`o3` → OpenAI; `gemini` → Google; otherwise → Anthropic). API keys are resolved in this order: extension `llm_api_key_encrypted` → profile `{provider}_api_key_encrypted`.

**Billing model:** Free (no subscription required).

---

### Tool Loop

Gives the Being an autonomous agentic loop: the LLM runs repeatedly, calling tools, until it reaches a final answer or the turn/timeout limit is hit.

**Endpoint:**

```
POST /v1/beings/:being_id/tool-loop
Authorization: Bearer <token>
Content-Type: application/json

{
  "prompt": "Research the top 3 competitors and write a summary to /workspace/competitors.md",
  "max_turns": 20,
  "timeout_ms": 300000
}
```

**Response:**
```json
{
  "result": "Final answer text from the LLM",
  "turns": 7,
  "tool_calls": [
    { "tool": "web_search", "input": { "query": "..." }, "result": "..." },
    ...
  ]
}
```

**Safety limits (from implementation):**

| Limit | Default | Notes |
|-------|---------|-------|
| `max_turns` | 20 | Hard cap on LLM iterations. Loop stops when `stop_reason !== 'tool_use'` or after `max_turns`. |
| `timeout_ms` | 300,000 ms (5 min) | AbortController is armed; any in-flight fetch is cancelled when the timeout fires. |
| Individual `exec` command timeout | 60 s (max 300 s) | Set via the `timeout` field in `exec` tool input. |

**Available tools in Tool Loop:**

| Tool | Always available | Requires Sandbox extension |
|------|-----------------|---------------------------|
| `get_current_time` | ✅ | — |
| `web_search` | ✅ | — |
| `web_fetch` | ✅ | — |
| `exec` | — | ✅ |
| `write_file` | — | ✅ |
| `read_file` | — | ✅ |
| `edit_file` | — | ✅ |
| `list_files` | — | ✅ |

The LLM API key for the tool loop is read from the `tool-loop` extension's `config.llm_api_key_encrypted`. It must be set via the config endpoint before use; without it the server returns `422`.

**Billing model:** Requires an active subscription (`SUBSCRIPTION_SLUGS = {'tool-loop', 'sandbox'}`).

---

### Sandbox

Enables file-system and code execution tools inside an isolated workspace backed by the user's GitHub repository.

When the sandbox extension is active and the tool loop is running, five additional tools become available:

| Tool | Description |
|------|-------------|
| `exec` | Run shell commands. Output includes stdout, stderr, exit code, files changed, and whether changes were pushed to Git. |
| `write_file` | Write or overwrite a file. Changes are committed and pushed to the configured GitHub branch. |
| `read_file` | Read a file up to 100 KB. Supports `offset`/`limit` for partial reads (1-indexed lines). |
| `edit_file` | Apply targeted text edits to a file. Each edit is a `{ oldText, newText }` pair; `oldText` must be unique in the file. |
| `list_files` | Show directory tree (default depth 3). Excludes `node_modules`, `.git`, `__pycache__`, `.next`. |

All sandbox operations require `github_repo_url` and a `github_token` to be set in the user's profile. The token is stored AES-encrypted in `profiles.github_token_encrypted`.

**Billing model:** Requires an active subscription (shares the subscription gate with `tool-loop`).

---

### Context Management (built-in, not an installable extension)

The Being Worker's standard chat loop (run by `process-job.ts`) always includes memory tools (`recall_memory`, `update_memory`, `update_notes`, `search_history`, `merge_nodes`) and the web tools (`web_search`, `web_fetch`) alongside capability tools from connected Bridges. These are not extensions but are part of the core tool set available in every conversation.

---

## Billing Summary

| Extension | Model |
|-----------|-------|
| Telegram BYOB | Free |
| Tool Loop | Subscription required (`subscriptions` table, `extension_slug='tool-loop'`, `status='active'`) |
| Sandbox | Subscription required (`extension_slug='sandbox'`) |
| Bridge / Sense-Act | Free |
