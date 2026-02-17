import type { WebMcpConfig } from "@/types";

const DEFAULT_HUB_URL = "https://webmcp-hub.com";

export async function getHubUrl(): Promise<string> {
  const data = await browser.storage.sync.get("hubUrl");
  return (data.hubUrl as string) || DEFAULT_HUB_URL;
}

export async function setHubUrl(url: string): Promise<void> {
  await browser.storage.sync.set({ hubUrl: url });
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

  const res = await fetch(`${hubBase}/api/configs/lookup?${params}`);
  return res.json() as Promise<{ configs: WebMcpConfig[] }>;
}
