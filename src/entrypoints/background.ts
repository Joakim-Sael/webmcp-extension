import { lookupConfig } from "@/lib/hub-client";

export default defineBackground(() => {
  // Track the last URL we processed per tab so we skip duplicate lookups
  const lastUrl = new Map<number, string>();
  // Monotonic counter per tab — stale responses are discarded after await
  const navSeq = new Map<number, number>();
  // Domain for which tools are currently registered per tab.
  // Used to decide whether an empty lookup result should wipe tools or be ignored.
  const registeredDomain = new Map<number, string>();

  async function handleNavigation(tabId: number, rawUrl: string) {
    try {
      const url = new URL(rawUrl);
      const host = url.hostname.replace(/^www\./, "");
      const domain =
        url.port && url.port !== "80" && url.port !== "443" ? `${host}:${url.port}` : host;

      // Send domain + pathname (no protocol/query) for URL pattern matching.
      // Patterns like "example.com/dashboard/:id" match against this.
      const normalizedUrl = domain + url.pathname;

      // Skip if we already processed this exact URL for this tab
      if (lastUrl.get(tabId) === normalizedUrl) return;
      lastUrl.set(tabId, normalizedUrl);

      // Increment sequence so we can detect if another navigation happened
      // while this lookup was in-flight
      const seq = (navSeq.get(tabId) ?? 0) + 1;
      navSeq.set(tabId, seq);

      const result = await lookupConfig(domain, normalizedUrl, {
        executable: true,
      });

      // Another navigation started while we were fetching — discard stale result
      if (navSeq.get(tabId) !== seq) return;

      // Don't wipe tools when a SPA navigation lands on a URL with no matching config
      // but the domain hasn't changed. This preserves tools across path-only navigations
      // (e.g. X.com reply dialog updating the URL from /home to /user/status/123).
      // Only send CONFIGS_FOUND when:
      //   a) There are configs to register, OR
      //   b) The domain changed — tools from the previous domain must be cleared
      const prevDomain = registeredDomain.get(tabId);
      const domainChanged = prevDomain !== undefined && prevDomain !== domain;

      if (result.configs.length === 0 && !domainChanged) return;

      registeredDomain.set(tabId, domain);

      // Store result in session storage keyed by tab ID
      await browser.storage.session.set({
        [`tab-${tabId}`]: {
          configs: result.configs,
          domain,
          timestamp: Date.now(),
        },
      });

      // Notify content script
      browser.tabs
        .sendMessage(tabId, {
          type: "CONFIGS_FOUND",
          configs: result.configs,
        })
        .catch(() => {
          // Content script may not be ready yet — expected during page load
        });
    } catch (error) {
      console.warn("WebMCP Hub: failed to look up configs:", error);
    }
  }

  // Full page navigations (traditional + hard reloads)
  browser.webNavigation.onCompleted.addListener(
    (details) => {
      if (details.frameId !== 0) return;
      // Clear dedup and domain tracking on full navigation so a fresh lookup always runs
      lastUrl.delete(details.tabId);
      registeredDomain.delete(details.tabId);
      handleNavigation(details.tabId, details.url);
    },
    { url: [{ schemes: ["http", "https"] }] },
  );

  // SPA navigations (pushState / replaceState) — URL changes without page reload
  browser.webNavigation.onHistoryStateUpdated.addListener(
    (details) => {
      if (details.frameId !== 0) return;
      handleNavigation(details.tabId, details.url);
    },
    { url: [{ schemes: ["http", "https"] }] },
  );

  // Clean up storage and tracking when tab is closed
  browser.tabs.onRemoved.addListener((tabId) => {
    browser.storage.session.remove(`tab-${tabId}`);
    lastUrl.delete(tabId);
    navSeq.delete(tabId);
    registeredDomain.delete(tabId);
  });
});
