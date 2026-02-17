import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: "src",
  manifest: {
    name: "WebMCP Hub",
    description: "Register WebMCP tools on pages with matching configs",
    icons: {
      16: "icon-16.png",
      48: "icon-48.png",
      128: "icon-128.png",
    },
    action: {
      default_icon: {
        16: "icon-16.png",
        48: "icon-48.png",
        128: "icon-128.png",
      },
    },
    permissions: [
      // webNavigation: detect page loads to look up matching configs
      "webNavigation",
      // activeTab: query current tab info in the popup
      "activeTab",
      // storage: persist hub URL setting (sync) and per-tab config cache (session)
      "storage",
    ],
    // <all_urls> is required because configs can target any domain.
    // The extension only injects tools when the hub returns a matching config
    // for the current page's domain — it does not read or modify page content
    // on sites without a config match.
    host_permissions: ["<all_urls>"],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
  },
});
