import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toFetchResponse, toReqRes } from "fetch-to-node";
import { z } from "zod";
import * as tavilyClient from "./tavily-client.js";
import { pickBestKey, addKey, deleteKey, listKeys, deductCredit, maybeSyncKeyUsage } from "./key-pool.js";

type Env = {
  KV: KVNamespace;
  AUTH_KEY: string;
};

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// Auth middleware: require x-api-key header on all routes except GET /
// ---------------------------------------------------------------------------
app.use("*", async (c, next) => {
  // Allow health check without auth
  if (c.req.path === "/" && c.req.method === "GET") {
    return next();
  }

  const provided = c.req.header("x-api-key");
  if (!provided || provided !== c.env.AUTH_KEY) {
    return c.json({ error: "Unauthorized: invalid or missing x-api-key header" }, 401);
  }

  return next();
});

// ---------------------------------------------------------------------------
// Helper: create a fresh MCP server with Tavily tools bound to a specific KV
// ---------------------------------------------------------------------------
function createMcpServer(kv: KVNamespace) {
  const server = new McpServer({
    name: "tavily-proxy",
    version: "1.0.0",
  });

  // -- tavily-search --------------------------------------------------------
  server.tool(
    "tavily-search",
    "A powerful web search tool that provides comprehensive, real-time results using Tavily's AI search engine. Returns relevant web content with titles, URLs, and content snippets. Supports filtering by topic, time range, domain inclusion/exclusion, and more.",
    {
      query: z.string().describe("The search query to execute with Tavily."),
      search_depth: z
        .enum(["advanced", "basic", "fast", "ultra-fast"])
        .optional()
        .default("basic")
        .describe(
          "Controls the latency vs. relevance tradeoff. 'advanced': highest relevance, increased latency (2 credits). 'basic': balanced (1 credit). 'fast': lower latency (1 credit). 'ultra-fast': minimum latency (1 credit)."
        ),
      topic: z
        .enum(["general", "news", "finance"])
        .optional()
        .default("general")
        .describe("The category of the search. 'news' for real-time updates, 'general' for broader searches, 'finance' for financial data."),
      max_results: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .default(5)
        .describe("The maximum number of search results to return (0-20)."),
      time_range: z
        .enum(["day", "week", "month", "year", "d", "w", "m", "y"])
        .optional()
        .describe("Time range to filter results based on publish/updated date."),
      include_answer: z
        .union([z.boolean(), z.enum(["basic", "advanced"])])
        .optional()
        .default(false)
        .describe("Include an LLM-generated answer. 'basic'/true for quick answer, 'advanced' for detailed."),
      include_raw_content: z
        .union([z.boolean(), z.enum(["markdown", "text"])])
        .optional()
        .default(false)
        .describe("Include cleaned HTML content. 'markdown'/true for markdown, 'text' for plain text."),
      include_images: z
        .boolean()
        .optional()
        .default(false)
        .describe("Also perform an image search and include results."),
      include_image_descriptions: z
        .boolean()
        .optional()
        .default(false)
        .describe("When include_images is true, also add descriptive text for each image."),
      include_domains: z
        .array(z.string())
        .optional()
        .describe("A list of domains to specifically include in results (max 300)."),
      exclude_domains: z
        .array(z.string())
        .optional()
        .describe("A list of domains to specifically exclude from results (max 150)."),
      chunks_per_source: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe("Max relevant chunks per source (1-3). Only for 'advanced' search_depth."),
      country: z
        .string()
        .optional()
        .describe("Boost results from a specific country. Only for 'general' topic."),
    },
    async (params) => {
      const apiKey = await pickBestKey(kv);
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "Error: No API keys available in the pool. Please add keys first." }],
          isError: true,
        };
      }
      console.log(`[MCP] tavily-search using key: ${apiKey.substring(0, 13)}...`);
      try {
        const result = await tavilyClient.search(apiKey, params);
        // Deduct credit (search_depth advanced = 2, otherwise 1)
        const cost = params.search_depth === "advanced" ? 2 : 1;
        await deductCredit(kv, apiKey, cost);
        await maybeSyncKeyUsage(kv, apiKey);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error calling Tavily search: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // -- tavily-extract -------------------------------------------------------
  server.tool(
    "tavily-extract",
    "Extract web page content from one or more specified URLs. Returns cleaned, parsed content optimized for LLMs. Supports basic and advanced extraction depths, optional image extraction, and content format selection.",
    {
      urls: z
        .union([z.string(), z.array(z.string())])
        .describe("A single URL or list of URLs to extract content from."),
      query: z
        .string()
        .optional()
        .describe("User intent for reranking extracted content chunks."),
      extract_depth: z
        .enum(["basic", "advanced"])
        .optional()
        .default("basic")
        .describe("Depth of extraction. 'advanced' retrieves more data including tables (2 credits/5 URLs vs 1 credit/5 URLs)."),
      include_images: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include images extracted from the URLs."),
      format: z
        .enum(["markdown", "text"])
        .optional()
        .default("markdown")
        .describe("Format of extracted content. 'markdown' or 'text'."),
      chunks_per_source: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Max relevant chunks per source (1-5). Only when 'query' is provided."),
    },
    async (params) => {
      const apiKey = await pickBestKey(kv);
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "Error: No API keys available in the pool. Please add keys first." }],
          isError: true,
        };
      }
      console.log(`[MCP] tavily-extract using key: ${apiKey.substring(0, 13)}...`);
      try {
        const result = await tavilyClient.extract(apiKey, params);
        // Estimate cost: 1 credit per 5 successful URLs for basic, 2 per 5 for advanced
        const urlCount = Array.isArray(params.urls) ? params.urls.length : 1;
        const costPer5 = params.extract_depth === "advanced" ? 2 : 1;
        const cost = Math.max(1, Math.ceil(urlCount / 5) * costPer5);
        await deductCredit(kv, apiKey, cost);
        await maybeSyncKeyUsage(kv, apiKey);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error calling Tavily extract: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // -- tavily-crawl ---------------------------------------------------------
  server.tool(
    "tavily-crawl",
    "A graph-based website traversal tool that explores hundreds of paths in parallel with built-in extraction and intelligent discovery. Crawls from a base URL, extracts content, and returns structured results.",
    {
      url: z.string().describe("The root URL to begin the crawl."),
      instructions: z
        .string()
        .optional()
        .describe("Natural language instructions for the crawler. Increases cost to 2 credits/10 pages."),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .default(1)
        .describe("Max depth from the base URL the crawler can explore (1-5)."),
      max_breadth: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(20)
        .describe("Max links to follow per page (1-500)."),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(50)
        .describe("Total links the crawler will process before stopping."),
      select_paths: z
        .array(z.string())
        .optional()
        .describe("Regex patterns to select only URLs with specific path patterns."),
      select_domains: z
        .array(z.string())
        .optional()
        .describe("Regex patterns to select specific domains or subdomains."),
      exclude_paths: z
        .array(z.string())
        .optional()
        .describe("Regex patterns to exclude URLs with specific path patterns."),
      exclude_domains: z
        .array(z.string())
        .optional()
        .describe("Regex patterns to exclude specific domains or subdomains."),
      allow_external: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to include external domain links in results."),
      include_images: z
        .boolean()
        .optional()
        .default(false)
        .describe("Whether to include images in crawl results."),
      extract_depth: z
        .enum(["basic", "advanced"])
        .optional()
        .default("basic")
        .describe("Extraction depth. 'advanced' retrieves more data but costs more."),
      format: z
        .enum(["markdown", "text"])
        .optional()
        .default("markdown")
        .describe("Format of extracted content."),
      chunks_per_source: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe("Max relevant chunks per source (1-5). Only when 'instructions' provided."),
    },
    async (params) => {
      const apiKey = await pickBestKey(kv);
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "Error: No API keys available in the pool. Please add keys first." }],
          isError: true,
        };
      }
      console.log(`[MCP] tavily-crawl using key: ${apiKey.substring(0, 13)}...`);
      try {
        const result = await tavilyClient.crawl(apiKey, params);
        // Estimate cost conservatively
        await deductCredit(kv, apiKey, 2);
        await maybeSyncKeyUsage(kv, apiKey);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error calling Tavily crawl: ${message}` }],
          isError: true,
        };
      }
    }
  );

  // -- tavily-map -----------------------------------------------------------
  server.tool(
    "tavily-map",
    "Traverses websites like a graph to generate comprehensive site maps. Explores hundreds of paths in parallel with intelligent discovery. Returns a list of discovered URLs.",
    {
      url: z.string().describe("The root URL to begin the mapping."),
      instructions: z
        .string()
        .optional()
        .describe("Natural language instructions for the mapper. Increases cost to 2 credits/10 pages."),
      max_depth: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .default(1)
        .describe("Max depth from the base URL (1-5)."),
      max_breadth: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(20)
        .describe("Max links to follow per page (1-500)."),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .default(50)
        .describe("Total links to process before stopping."),
      select_paths: z
        .array(z.string())
        .optional()
        .describe("Regex patterns to select only URLs with specific path patterns."),
      select_domains: z
        .array(z.string())
        .optional()
        .describe("Regex patterns to select specific domains or subdomains."),
      exclude_paths: z
        .array(z.string())
        .optional()
        .describe("Regex patterns to exclude URLs with specific path patterns."),
      exclude_domains: z
        .array(z.string())
        .optional()
        .describe("Regex patterns to exclude specific domains or subdomains."),
      allow_external: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to include external domain links."),
    },
    async (params) => {
      const apiKey = await pickBestKey(kv);
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "Error: No API keys available in the pool. Please add keys first." }],
          isError: true,
        };
      }
      console.log(`[MCP] tavily-map using key: ${apiKey.substring(0, 13)}...`);
      try {
        const result = await tavilyClient.map(apiKey, params);
        await deductCredit(kv, apiKey, 1);
        await maybeSyncKeyUsage(kv, apiKey);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error calling Tavily map: ${message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// MCP endpoint - /mcp
// Matches the Tavily official MCP endpoint path
// ---------------------------------------------------------------------------
app.post("/mcp", async (c) => {
  const { req, res } = toReqRes(c.req.raw);
  const server = createMcpServer(c.env.KV);

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, await c.req.json());

    res.on("close", () => {
      transport.close();
      server.close();
    });

    return toFetchResponse(res);
  } catch (error) {
    console.error("MCP error:", error);
    return c.json({ error: "Internal MCP server error" }, 500);
  }
});

app.get("/mcp", async (c) => {
  return c.json({ error: "Method not allowed. MCP requires POST." }, 405);
});

app.delete("/mcp", async (c) => {
  return c.json({ error: "Method not allowed." }, 405);
});

// ---------------------------------------------------------------------------
// HTTP API: Key Management
// ---------------------------------------------------------------------------

// Add a key (queries Tavily for remaining credit, inserts/updates KV)
app.post("/api/keys", async (c) => {
  try {
    const body = await c.req.json<{ apiKey: string }>();
    if (!body.apiKey) {
      return c.json({ error: "Missing 'apiKey' in request body" }, 400);
    }
    const info = await addKey(c.env.KV, body.apiKey);
    return c.json({ success: true, key: info });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// Delete a key
app.delete("/api/keys", async (c) => {
  try {
    const body = await c.req.json<{ apiKey: string }>();
    if (!body.apiKey) {
      return c.json({ error: "Missing 'apiKey' in request body" }, 400);
    }
    await deleteKey(c.env.KV, body.apiKey);
    return c.json({ success: true, deleted: body.apiKey });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// ---------------------------------------------------------------------------
// HTTP API: Query all keys status
// ---------------------------------------------------------------------------
app.get("/api/keys", async (c) => {
  try {
    const keys = await listKeys(c.env.KV);
    return c.json({ keys });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// ---------------------------------------------------------------------------
// Health check / root
// ---------------------------------------------------------------------------
app.get("/", (c) => {
  return c.json({
    service: "tavily-proxy",
    version: "1.0.0",
    endpoints: {
      mcp: "POST /mcp",
      addKey: "POST /api/keys { apiKey: string }",
      deleteKey: "DELETE /api/keys { apiKey: string }",
      listKeys: "GET /api/keys",
    },
  });
});

export default app;
