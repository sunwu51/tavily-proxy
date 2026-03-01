/**
 * Key pool management for Tavily API keys stored in Cloudflare KV.
 *
 * KV schema: key = Tavily API key (e.g. "tvly-xxx"), value = remaining credit (number as string).
 */

export interface KeyInfo {
  apiKey: string;
  remainingCredit: number;
}

/**
 * Query the Tavily /usage endpoint to get remaining credits for a key.
 */
export async function queryRemainingCredit(apiKey: string): Promise<number> {
  const keyPrefix = apiKey.substring(0, 13);
  const res = await fetch("https://api.tavily.com/usage", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    console.log(`[usage] key=${keyPrefix}... response=${res.status} ${text}`);
    throw new Error(`Failed to query usage for key: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    key: { usage: number; limit: number | null };
    account: { plan_limit: number; plan_usage: number };
  };

  console.log(`[usage] key=${keyPrefix}... response=${JSON.stringify(data)}`);

  // remaining = limit - usage. If limit is null (unlimited), report a large number.
  const limit = data.key.limit ?? data.account.plan_limit;
  const usage = data.key.usage;
  return Math.max(0, limit - usage);
}

/**
 * List all keys from KV using cached values (no Tavily API call).
 */
async function listKeysFromCache(kv: KVNamespace): Promise<KeyInfo[]> {
  const keys: KeyInfo[] = [];
  let cursor: string | undefined;

  do {
    const result = await kv.list({ cursor });
    for (const key of result.keys) {
      const value = await kv.get(key.name);
      keys.push({
        apiKey: key.name,
        remainingCredit: value ? Number(value) : 0,
      });
    }
    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  return keys;
}

/**
 * List all keys from KV with their remaining credits (reads from cache only).
 */
export async function listKeys(kv: KVNamespace): Promise<KeyInfo[]> {
  return listKeysFromCache(kv);
}

/**
 * Pick the key with the most remaining credit using cached KV values.
 * If multiple keys have the same credit, pick the first one alphabetically.
 * Returns null if no keys are available.
 */
export async function pickBestKey(kv: KVNamespace): Promise<string | null> {
  const keys = await listKeysFromCache(kv);
  if (keys.length === 0) return null;

  keys.sort((a, b) => {
    if (b.remainingCredit !== a.remainingCredit) {
      return b.remainingCredit - a.remainingCredit;
    }
    return a.apiKey.localeCompare(b.apiKey);
  });
  const best = keys[0];
  if (best.remainingCredit <= 0) return null;
  return best.apiKey;
}

/**
 * Add or update a key in KV. Queries the Tavily API for current remaining credit.
 */
export async function addKey(kv: KVNamespace, apiKey: string): Promise<KeyInfo> {
  const remaining = await queryRemainingCredit(apiKey);
  await kv.put(apiKey, String(remaining));
  return { apiKey, remainingCredit: remaining };
}

/**
 * Delete a key from KV.
 */
export async function deleteKey(kv: KVNamespace, apiKey: string): Promise<void> {
  await kv.delete(apiKey);
}

/**
 * Deduct credit from a key after a request.
 * This is a best-effort local update; we periodically re-sync from the API.
 */
export async function deductCredit(kv: KVNamespace, apiKey: string, amount: number): Promise<void> {
  const current = await kv.get(apiKey);
  if (current !== null) {
    const newVal = Math.max(0, Number(current) - amount);
    await kv.put(apiKey, String(newVal));
  }
}

/**
 * Query the real usage from Tavily and update KV after each MCP tool call.
 */
export async function maybeSyncKeyUsage(kv: KVNamespace, apiKey: string): Promise<void> {

  try {
    const remaining = await queryRemainingCredit(apiKey);
    await kv.put(apiKey, String(remaining));
  } catch (err) {
    console.error(`[sync] Failed to sync usage for key ${apiKey.substring(0, 13)}...:`, err);
    await kv.put(apiKey, "0");
  }
}
