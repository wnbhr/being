# @ruddia/being-mcp-server

MCP server for [Being](https://github.com/wnbhr/being) — a Personality Runtime that gives AI agents persistent memory, personality, and relationships.

Connect from any MCP-compatible client: OpenClaw, Claude Desktop, Claude Cowork, Claude Managed Agents, and more.

## Quick Start

```bash
npm install -g @ruddia/being-mcp-server

BEING_API_URL=https://your-being-worker.example.com \
BEING_API_TOKEN=brt_xxx \
BEING_ID=your-being-id \
being-mcp-server
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `BEING_API_URL` | — | Being Worker base URL (default: `http://localhost:3100`) |
| `BEING_API_TOKEN` | ✅ | Auth token (`brt_...` — issued from the dashboard) |
| `BEING_ID` | ✅ | Target Being ID |
| `LLM_API_KEY` | For `trigger_patrol` | Anthropic API key (BYOK) |

## Transport Modes

### stdio (default)

For OpenClaw, Claude Desktop, MCP Inspector, etc.

```bash
being-mcp-server
```

### Streamable HTTP

For Claude Cowork, Managed Agents, and remote connections.

```bash
being-mcp-server --http --port 3200
```

Endpoint: `POST /mcp`

## Tools

| Tool | Description | LLM Key |
|---|---|---|
| `recall_memory` | Search memory graph for relevant nodes | — |
| `merge_nodes` | Merge similar memory nodes | — |
| `update_memory` | Read/write partner memory (preferences, knowledge, relationships, notes, etc.) | — |
| `conclude_topic` | Archive current topic and save summary | — |
| `search_history` | Search past conversation history | — |
| `update_relation` | Update relationships with external entities | — |
| `get_current_time` | Get current time (JST) | — |
| `trigger_patrol` | Run patrol — extract scenes and generate memory nodes | **Required** |

## Client Configuration Examples

### OpenClaw / Claude Desktop

```json
{
  "mcpServers": {
    "being": {
      "command": "npx",
      "args": ["-y", "@ruddia/being-mcp-server"],
      "env": {
        "BEING_API_URL": "https://your-being-worker.example.com",
        "BEING_API_TOKEN": "brt_xxx",
        "BEING_ID": "your-being-id"
      }
    }
  }
}
```

### Streamable HTTP (Cowork / Managed Agents)

```json
{
  "mcpServers": {
    "being": {
      "url": "http://localhost:3200/mcp"
    }
  }
}
```

## What is Being?

Being is a **Personality Runtime** — an open-source layer that gives AI agents:

- 🧠 **Persistent Memory** — Graph-based memory with automatic consolidation and decay
- 🎭 **Personality** — SOUL definitions that shape voice, values, and behavior
- 🤝 **Relationships** — Track and evolve connections with users and entities
- 🔄 **Patrol** — Autonomous memory processing (scene extraction, consolidation, reflection)

Learn more at [github.com/wnbhr/being](https://github.com/wnbhr/being).

## License

MIT
