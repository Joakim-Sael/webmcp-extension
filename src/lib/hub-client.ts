import type { WebMcpConfig } from "@/types";

const DEFAULT_HUB_URL = "https://webmcp-hub.com";

export async function getHubUrl(): Promise<string> {
  const data = await browser.storage.sync.get("hubUrl");
  return (data.hubUrl as string) || DEFAULT_HUB_URL;
}

export async function setHubUrl(url: string): Promise<void> {
  await browser.storage.sync.set({ hubUrl: url });
}

export async function getApiKey(): Promise<string> {
  const data = await browser.storage.local.get("apiKey");
  return (data.apiKey as string) || "";
}

export async function setApiKey(key: string): Promise<void> {
  await browser.storage.local.set({ apiKey: key });
}

export async function lookupConfig(
  domain: string,
  url?: string,
  opts?: { executable?: boolean },
): Promise<{ configs: WebMcpConfig[] }> {
  const hubBase = await getHubUrl();
  const params = new URLSearchParams({ domain });
  if (url) params.set("url", url);
  if (opts?.executable) params.set("executable", "true");

  const headers: Record<string, string> = {};
  const apiKey = await getApiKey();
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${hubBase}/api/configs/lookup?${params}`, { headers });
  return res.json() as Promise<{ configs: WebMcpConfig[] }>;
}
