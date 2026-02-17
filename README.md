# WebMCP Hub — Chrome Extension

A Chrome extension that brings [WebMCP](https://developer.chrome.com/blog/webmcp-epp) tool configurations to every website. On each page navigation, it looks up matching configs from [WebMCP Hub](https://www.webmcp-hub.com/) and registers executable tools via `navigator.modelContext`.

> **Note:** This extension is pending approval on the Chrome Web Store. In the meantime, you can install it manually from source (see below).

## Prerequisites

WebMCP is an early-stage browser API. To use this extension you need:

1. **Chrome Canary/Dev** — version **146.0.7672.0** or higher
2. **Enable the WebMCP flag** — go to `chrome://flags`, search for **"WebMCP for testing"** and enable it
3. **Model Context Tool Inspector** — install the [Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd) extension (or [clone/fork the source](https://github.com/beaufortfrancois/model-context-tool-inspector))

The Tool Inspector lets you see and test the tools that this extension registers on each page.

## Getting started

### 1. Install from source

```bash
git clone https://github.com/Joakim-Sael/webmcp-extension.git
cd webmcp-extension
npm install
npm run build
```

### 2. Load into Chrome

1. Open `chrome://extensions`
2. Enable **"Developer mode"** (top right)
3. Click **"Load unpacked"**
4. Select the `.output/chrome-mv3` directory

### 3. Test it out

1. Make sure the [Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd) is installed
2. Visit a website that has a config in the hub
3. Open the Tool Inspector — you should see the registered tools
4. Try executing a tool to verify everything works

## How it works

1. You visit a website
2. The extension checks the hub API for configs matching that domain
3. If tools with `execution` metadata are found, they're registered via the WebMCP browser API
4. AI agents (or the Tool Inspector) can now interact with the page using those tools

## Development

```bash
# Install dependencies
npm install

# Start dev mode (auto-reloads on changes)
npm run dev

# Build for production
npm run build
```

The production build outputs to `.output/chrome-mv3/`.

## Configuration

Click the extension icon to open the popup. You can configure a custom hub URL if you're running your own instance of [WebMCP Hub](https://github.com/Joakim-Sael/web-mcp-hub).

## Project structure

```
src/
├── entrypoints/
│   ├── background.ts       # Listens for navigations, looks up configs from the hub
│   ├── content.ts           # Registers tools via navigator.modelContext
│   └── popup/               # Extension popup UI
│       ├── index.html
│       └── main.ts
├── lib/
│   └── hub-client.ts        # Hub API client
└── types.ts                 # WebMCP type definitions
```

## License

MIT

---

> This repo is automatically synced from the [WebMCP Hub monorepo](https://github.com/Joakim-Sael/web-mcp-hub). To contribute, please open PRs there.
