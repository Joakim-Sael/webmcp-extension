import type { WebMcpConfig } from "@/types";
import { getHubUrl, setHubUrl } from "@/lib/hub-client";

async function init() {
  const statusEl = document.getElementById("status")!;
  const hubUrlInput = document.getElementById("hubUrl") as HTMLInputElement;
  const savedEl = document.getElementById("saved")!;

  // Load current hub URL into input
  hubUrlInput.value = await getHubUrl();

  // Save on change (debounced)
  let saveTimeout: ReturnType<typeof setTimeout>;
  hubUrlInput.addEventListener("input", () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      const value = hubUrlInput.value.trim();
      if (value) {
        await setHubUrl(value);
        savedEl.style.display = "block";
        setTimeout(() => {
          savedEl.style.display = "none";
        }, 1500);
      }
    }, 500);
  });

  const [tab] = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!tab?.id) {
    statusEl.textContent = "No active tab";
    statusEl.className = "status none";
    return;
  }

  const data = await browser.storage.session.get(`tab-${tab.id}`);
  const entry = data[`tab-${tab.id}`] as { configs: WebMcpConfig[]; domain: string } | undefined;

  if (!entry || entry.configs.length === 0) {
    statusEl.textContent = "No configs found for this page";
    statusEl.className = "status none";
    return;
  }

  const totalTools = entry.configs.reduce((sum, c) => sum + c.tools.length, 0);

  statusEl.innerHTML = `<span class="found">Config found for ${entry.domain}</span><br/>${entry.configs.length} config(s), ${totalTools} tool(s)`;
}

init();
