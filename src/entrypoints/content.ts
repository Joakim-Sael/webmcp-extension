import type { WebMcpConfig, ExecutionDescriptor, ActionStep, ToolField } from "@/types";

type AgentInterface = {
  requestUserInteraction: (callback: () => Promise<unknown>) => Promise<unknown>;
};

type ToolExecuteFn = (params: Record<string, unknown>, agent: AgentInterface) => Promise<unknown>;

type ToolRegistration = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, string>;
  execute: ToolExecuteFn;
};

type ModelContext = {
  provideContext: (ctx: { tools: ToolRegistration[] }) => void;
  registerTool: (descriptor: ToolRegistration) => void;
  unregisterTool?: (name: string) => void;
};

// Track currently registered tool names so we can clean up on page change
const registeredTools = new Set<string>();

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    // Listen for CONFIGS_FOUND from background
    browser.runtime.onMessage.addListener((message) => {
      if (message.type === "CONFIGS_FOUND" && message.configs) {
        registerTools(message.configs as WebMcpConfig[]);
      }
    });
  },
});

// WebMCP result format per spec
function mcpResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function getModelContext(): ModelContext | undefined {
  return (navigator as Navigator & { modelContext?: ModelContext }).modelContext;
}

function registerTools(configs: WebMcpConfig[]) {
  const ctx = getModelContext();
  if (!ctx) return;

  // Skip tools whose names conflict with declarative tools already on the page
  const declarativeNames = new Set<string>();
  document.querySelectorAll<HTMLFormElement>("form[toolname]").forEach((form) => {
    const name = form.getAttribute("toolname");
    if (name) declarativeNames.add(name);
  });

  // Build the full set of tool registrations
  const tools: ToolRegistration[] = [];
  const seen = new Set<string>();
  for (const config of configs) {
    for (const tool of config.tools) {
      if (!tool.execution) continue;
      if (seen.has(tool.name)) continue;
      if (declarativeNames.has(tool.name)) {
        console.warn(
          `[web-mcp-hub] Skipping tool "${tool.name}" — conflicts with declarative tool on page`,
        );
        continue;
      }
      seen.add(tool.name);

      tools.push({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations && { annotations: tool.annotations }),
        execute: (params, agent) =>
          executeTool(tool.name, tool.execution!, params, agent, tool.annotations),
      });
    }
  }

  // Use provideContext for atomic replacement when available, fall back to register/unregister
  if (ctx.provideContext) {
    ctx.provideContext({ tools });
  } else {
    if (ctx.unregisterTool) {
      for (const name of registeredTools) {
        if (!seen.has(name)) ctx.unregisterTool(name);
      }
    }
    for (const tool of tools) {
      ctx.registerTool(tool);
    }
  }

  registeredTools.clear();
  for (const name of seen) registeredTools.add(name);
}

async function executeTool(
  toolName: string,
  exec: ExecutionDescriptor,
  params: Record<string, unknown>,
  agent?: AgentInterface,
  annotations?: Record<string, string>,
): Promise<unknown> {
  // Request user confirmation for destructive tools per WebMCP spec
  if (agent && annotations?.destructiveHint === "true") {
    const confirmed = await agent.requestUserInteraction(async () => {
      return confirm(`Allow "${toolName}" to make changes?`);
    });
    if (!confirmed) {
      return mcpResult(`Tool "${toolName}" cancelled by user.`);
    }
  }

  // Multi-step mode
  if (exec.steps && exec.steps.length > 0) {
    let lastResult: unknown = null;
    for (const step of exec.steps) {
      lastResult = await executeStep(step, params);
    }
    return mcpResult(lastResult != null ? String(lastResult) : `Executed ${toolName}`);
  }

  // Simple mode — fill fields
  const errors: string[] = [];
  if (exec.fields) {
    for (const field of exec.fields) {
      const value = params[field.name];
      if (value !== undefined) {
        const err = await fillToolField(field, value);
        if (err) errors.push(`Field "${field.name}": ${err}`);
      }
    }
  }

  // Submit — return immediately since it may cause navigation
  if (exec.autosubmit) {
    const errorSuffix = errors.length > 0 ? `\nWarnings:\n${errors.join("\n")}` : "";
    if (exec.submitAction === "enter") {
      const target = exec.fields?.length
        ? document.querySelector<HTMLElement>(exec.fields[exec.fields.length - 1].selector)
        : (query(exec.selector, params) as HTMLElement | null);
      if (target) {
        const form = target.closest("form");
        if (form) {
          // Return result BEFORE submitting to avoid navigation destroying context
          setTimeout(() => form.requestSubmit(), 0);
          return mcpResult(`Submitted ${toolName}${errorSuffix}`);
        } else {
          target.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }),
          );
          target.dispatchEvent(
            new KeyboardEvent("keypress", { key: "Enter", code: "Enter", bubbles: true }),
          );
          target.dispatchEvent(
            new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }),
          );
          return mcpResult(`Submitted ${toolName}${errorSuffix}`);
        }
      }
      return mcpResult(
        `Error: Submit target not found for "${toolName}". Selector: ${exec.selector}${errorSuffix}`,
      );
    } else {
      const submitEl = exec.submitSelector
        ? (query(exec.submitSelector, params) as HTMLElement | null)
        : (query(interpolate(exec.selector, params) + ` [type="submit"]`) as HTMLElement | null);
      const clickTarget = submitEl ?? (query(exec.selector, params) as HTMLElement | null);
      if (clickTarget) {
        // Defer click to let return happen first (in case of navigation)
        setTimeout(() => clickTarget.click(), 0);
        return mcpResult(`Submitted ${toolName}${errorSuffix}`);
      }
      return mcpResult(
        `Error: Submit button not found for "${toolName}". Selector: ${exec.submitSelector ?? exec.selector}${errorSuffix}`,
      );
    }
  }

  if (errors.length > 0) {
    return mcpResult(`Error filling fields for "${toolName}":\n${errors.join("\n")}`);
  }

  // Extract result (no submit)
  if (exec.resultWaitSelector) {
    await waitForSelector(exec.resultWaitSelector);
  } else if (exec.resultDelay) {
    await new Promise((r) => setTimeout(r, exec.resultDelay));
  }

  if (exec.resultSelector) {
    const result = extractResult(
      exec.resultSelector,
      exec.resultExtract ?? "text",
      exec.resultAttribute,
    );
    if (Array.isArray(result)) {
      return mcpResult(result.join("\n"));
    }
    return mcpResult(result != null ? String(result) : "No result found");
  }

  return mcpResult(`Executed ${toolName}`);
}

async function executeStep(step: ActionStep, params: Record<string, unknown>): Promise<unknown> {
  switch (step.action) {
    case "navigate": {
      const url = interpolate(step.url, params);
      window.location.href = url;
      return `Navigating to ${url}`;
    }
    case "click": {
      const el = query(step.selector, params) as HTMLElement | null;
      if (!el) return `Error: Click target not found: ${step.selector}`;
      el.click();
      return null;
    }
    case "fill": {
      const value = interpolate(step.value, params);
      const err = await fillField(step.selector, value);
      return err ? `Error: ${err}` : null;
    }
    case "select": {
      const value = interpolate(step.value, params);
      const err = await fillField(step.selector, value);
      return err ? `Error: ${err}` : null;
    }
    case "wait": {
      await waitForSelector(step.selector, step.state, step.timeout);
      return null;
    }
    case "extract": {
      return extractResult(step.selector, step.extract);
    }
    case "scroll": {
      const el = query(step.selector, params);
      if (!el) return `Error: Scroll target not found: ${step.selector}`;
      el.scrollIntoView({ behavior: "smooth" });
      return null;
    }
    case "condition": {
      const el = query(step.selector, params);
      const match = checkState(el, step.state);
      const branch = match ? step.then : step.else;
      if (branch) {
        let result: unknown = null;
        for (const s of branch) {
          result = await executeStep(s, params);
        }
        return result;
      }
      return null;
    }
  }
}

function interpolate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(params[key] ?? ""));
}

/** Fill a tool field, handling radio options with per-option selectors. */
async function fillToolField(field: ToolField, value: unknown): Promise<string | null> {
  if (field.type === "radio" && field.options) {
    const option = field.options.find((o) => o.value === String(value));
    if (!option) return `No radio option matches value "${value}"`;
    const el = document.querySelector<HTMLInputElement>(option.selector);
    if (!el) return `Radio option element not found: ${option.selector}`;
    el.checked = true;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return null;
  }
  return fillField(field.selector, value);
}

/** Fill a DOM field. Returns an error message if the element was not found, or null on success. */
async function fillField(selector: string, value: unknown): Promise<string | null> {
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    selector,
  );
  if (!el) return `Element not found: ${selector}`;

  if (el instanceof HTMLSelectElement) {
    el.value = String(value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el instanceof HTMLInputElement && el.type === "checkbox") {
    el.checked = Boolean(value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el instanceof HTMLInputElement && el.type === "radio") {
    // Radio: check this specific input if its value matches, otherwise just check it
    el.checked = true;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    el.value = String(value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return null;
}

async function waitForSelector(
  selector: string,
  state: "visible" | "exists" | "hidden" = "visible",
  timeout = 5000,
): Promise<void> {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const el = query(selector);

      if (state === "hidden" && !el) return resolve();
      if (state === "exists" && el) return resolve();
      if (state === "visible" && el && (el as HTMLElement).offsetParent !== null) return resolve();

      if (Date.now() - start > timeout) {
        return reject(new Error(`Timeout waiting for ${selector}`));
      }

      requestAnimationFrame(check);
    };

    check();
  });
}

function extractResult(
  selector: string,
  mode: "text" | "html" | "list" | "table" | "attribute",
  attribute?: string,
): unknown {
  if (mode === "list") {
    const els = queryAll(selector);
    return els.map((el) => el.textContent?.trim() ?? "");
  }

  if (mode === "table") {
    const rows = queryAll(`${selector} tr`);
    return rows.map((row) => {
      const cells = row.querySelectorAll("td, th");
      return Array.from(cells).map((c) => c.textContent?.trim() ?? "");
    });
  }

  const el = query(selector);
  if (!el) return null;

  if (mode === "html") return el.innerHTML;
  if (mode === "attribute" && attribute) return el.getAttribute(attribute);
  return el.textContent?.trim() ?? "";
}

function checkState(el: Element | null, state: "visible" | "exists" | "hidden"): boolean {
  if (state === "hidden") return !el;
  if (state === "exists") return !!el;
  return !!el && (el as HTMLElement).offsetParent !== null;
}

// Support :has-text("...") pseudo-selector (not native CSS)
function query(selector: string, params?: Record<string, unknown>): Element | null {
  const resolved = params ? interpolate(selector, params) : selector;
  const match = resolved.match(/^(.+?):has-text\(["'](.+?)["']\)\s*(.*)$/);
  if (!match) return document.querySelector(resolved);

  const [, base, text, suffix] = match;
  const els = document.querySelectorAll(base);
  for (const el of els) {
    if (el.textContent?.includes(text)) {
      return suffix ? el.querySelector(suffix) : el;
    }
  }
  return null;
}

function queryAll(selector: string, params?: Record<string, unknown>): Element[] {
  const resolved = params ? interpolate(selector, params) : selector;
  const match = resolved.match(/^(.+?):has-text\(["'](.+?)["']\)\s*(.*)$/);
  if (!match) return Array.from(document.querySelectorAll(resolved));

  const [, base, text, suffix] = match;
  const els = document.querySelectorAll(base);
  const results: Element[] = [];
  for (const el of els) {
    if (el.textContent?.includes(text)) {
      if (suffix) {
        const child = el.querySelector(suffix);
        if (child) results.push(child);
      } else {
        results.push(el);
      }
    }
  }
  return results;
}
