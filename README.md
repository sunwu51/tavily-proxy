# tavily-proxy

A Cloudflare Worker that acts as an MCP (Model Context Protocol) proxy for the [Tavily API](https://tavily.com). It provides the same tools as the official Tavily MCP server, but with an **API key pool** — automatically rotating through multiple Tavily keys and selecting the one with the most remaining credit.

## Features

- **MCP Server** — Streamable HTTP transport at `POST /mcp`, compatible with any MCP client
- **4 Tavily Tools** — `tavily-search`, `tavily-extract`, `tavily-crawl`, `tavily-map`
- **API Key Pool** — Multiple Tavily API keys stored in Cloudflare KV; each request picks the key with the highest remaining credit
- **Key Management API** — HTTP endpoints to add/delete keys and query their status
- **Auth Protected** — All endpoints (except health check) require an `x-api-key` header

## Endpoints

| Method   | Path        | Description                                      |
|----------|-------------|--------------------------------------------------|
| `POST`   | `/mcp`      | MCP Streamable HTTP endpoint (tool calls)        |
| `POST`   | `/api/keys` | Add a Tavily API key to the pool                 |
| `DELETE` | `/api/keys` | Remove a Tavily API key from the pool            |
| `GET`    | `/api/keys` | List all keys and their remaining credits        |
| `GET`    | `/`         | Health check (no auth required)                  |

All endpoints except `GET /` require the `x-api-key` header matching your configured `AUTH_KEY`.

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A Cloudflare account

### Local Development

```bash
# Install dependencies
npm install

# Set your auth key for local dev (already in .dev.vars)
# AUTH_KEY=test-secret-key

# Start local server
npm run dev
```

Wrangler simulates KV locally — no Cloudflare account needed for development.

### Deploy to Production

1. **Create a KV namespace:**
   ```bash
   npx wrangler kv namespace create KV
   ```

2. **Update `wrangler.toml`** — replace `YOUR_KV_NAMESPACE_ID` with the real ID from step 1.

3. **Set the auth secret:**
   ```bash
   npx wrangler secret put AUTH_KEY
   ```

4. **Deploy:**
   ```bash
   npm run deploy
   ```

5. **Add Tavily API keys to the pool:**
   ```bash
   curl -X POST https://your-worker.workers.dev/api/keys \
     -H "Content-Type: application/json" \
     -H "x-api-key: your-auth-key" \
     -d '{"apiKey": "tvly-xxx"}'
   ```

## Usage

### Connect MCP Clients

With `mcp-remote` (for clients like Cursor, Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "tavily-proxy": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://your-worker.workers.dev/mcp",
        "--header", "x-api-key:${AUTH_KEY}"
      ],
      "env": {
        "AUTH_KEY": "your-auth-key"
      }
    }
  }
}
```

### Key Management

```bash
# Add a key (auto-queries remaining credit from Tavily)
curl -X POST https://your-worker.workers.dev/api/keys \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-auth-key" \
  -d '{"apiKey": "tvly-xxx"}'

# List all keys and credits
curl https://your-worker.workers.dev/api/keys \
  -H "x-api-key: your-auth-key"

# Delete a key
curl -X DELETE https://your-worker.workers.dev/api/keys \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-auth-key" \
  -d '{"apiKey": "tvly-xxx"}'
```

## How the Key Pool Works

1. When a tool is called, `KV.list()` retrieves all stored API keys
2. The key with the **largest remaining credit** is selected
3. The request is proxied to `api.tavily.com` using that key
4. After the call, the estimated credit cost is deducted locally in KV
5. When a key is added via `/api/keys`, its real remaining credit is fetched from Tavily's `/usage` endpoint

## License

ISC
