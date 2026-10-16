/** GET with timeout and retries on network errors, 429 and 5xx (not on other 4xx). */
export async function fetchText(
  url: string,
  headers: Record<string, string> = {},
  attempts = 3,
): Promise<string> {
  let lastErr: Error | undefined;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
      if (res.ok) return await res.text();
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastErr = err as Error;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
  }
  throw lastErr ?? new Error('fetch failed');
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
