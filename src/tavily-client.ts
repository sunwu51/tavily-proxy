/**
 * Thin wrapper around the Tavily REST API.
 */

const TAVILY_BASE = "https://api.tavily.com";

async function tavilyRequest(
  endpoint: string,
  method: "GET" | "POST",
  apiKey: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const res = await fetch(`${TAVILY_BASE}${endpoint}`, {
    method,
    headers,
    body: method === "POST" && body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily API error ${res.status}: ${text}`);
  }

  return res.json();
}

export async function search(apiKey: string, params: Record<string, unknown>) {
  return tavilyRequest("/search", "POST", apiKey, params);
}

export async function extract(apiKey: string, params: Record<string, unknown>) {
  return tavilyRequest("/extract", "POST", apiKey, params);
}

export async function crawl(apiKey: string, params: Record<string, unknown>) {
  return tavilyRequest("/crawl", "POST", apiKey, params);
}

export async function map(apiKey: string, params: Record<string, unknown>) {
  return tavilyRequest("/map", "POST", apiKey, params);
}
