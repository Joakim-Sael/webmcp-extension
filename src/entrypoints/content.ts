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
  try {
    return await executeToolInner(toolName, exec, params, agent, annotations);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[webmcp-hub] Tool "${toolName}" threw:`, err);
    return mcpResult(`Error executing "${toolName}": ${msg}`);
  }
}

async function executeToolInner(
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
        ? (deepQuery(exec.fields[exec.fields.length - 1].selector) as HTMLElement | null)
        : (query(exec.selector, params) as HTMLElement | null);
      if (target) {
        const form = target.closest("form");
        if (form) {
          form.requestSubmit();
          return mcpResult(`Submitted ${toolName}${errorSuffix}`);
        } else {
          target.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, composed: true }),
          );
          target.dispatchEvent(
            new KeyboardEvent("keypress", { key: "Enter", code: "Enter", bubbles: true, composed: true }),
          );
          target.dispatchEvent(
            new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true, composed: true }),
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
        clickTarget.click();
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
    if (exec.resultRequired) {
      await waitForSelector(exec.resultWaitSelector);
    } else {
      await waitForSelector(exec.resultWaitSelector).catch(() => null);
    }
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

function realClick(el: HTMLElement) {
  // Use element center coordinates so handlers that check clientX/clientY
  // (animations, hit-tests) receive plausible values.
  const rect = el.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);

  const bubbling: PointerEventInit & MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    pointerId: 1,
    isPrimary: true,
  };
  // pointerenter/pointerleave and mouseenter/mouseleave must NOT bubble — they are
  // boundary events and React's root-level delegation relies on them being non-bubbling.
  const nonBubbling: PointerEventInit & MouseEventInit = {
    ...bubbling,
    bubbles: false,
    cancelable: false,
  };

  el.dispatchEvent(new PointerEvent("pointerover", bubbling));
  el.dispatchEvent(new PointerEvent("pointerenter", nonBubbling));
  el.dispatchEvent(new MouseEvent("mouseover", bubbling));
  el.dispatchEvent(new MouseEvent("mouseenter", nonBubbling));
  el.dispatchEvent(new PointerEvent("pointerdown", bubbling));
  el.dispatchEvent(new MouseEvent("mousedown", bubbling));
  el.dispatchEvent(new PointerEvent("pointerup", bubbling));
  el.dispatchEvent(new MouseEvent("mouseup", bubbling));
  el.dispatchEvent(new MouseEvent("click", bubbling));
  el.dispatchEvent(new PointerEvent("pointerout", bubbling));
  el.dispatchEvent(new PointerEvent("pointerleave", nonBubbling));
  el.dispatchEvent(new MouseEvent("mouseout", bubbling));
  el.dispatchEvent(new MouseEvent("mouseleave", nonBubbling));
}

async function executeStep(step: ActionStep, params: Record<string, unknown>): Promise<unknown> {
  switch (step.action) {
    case "navigate": {
      const url = interpolate(step.url, params);
      window.location.href = url;
      return `Navigating to ${url}`;
    }
    case "click": {
      const el = await waitForClickable(step.selector, params);
      if (!el) return `Error: Click target not found or not clickable: ${step.selector}`;
      // Use native .click() so the event has isTrusted:true — sites like X.com
      // check isTrusted on reply/like handlers and ignore synthetic events.
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
      // Soft wait — timeout is non-fatal so a slow response doesn't crash the tool
      await waitForSelector(step.selector, step.state, step.timeout).catch(() => null);
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
    case "evaluate": {
      if (step.value) {
        try {
          // eslint-disable-next-line no-new-func
          await new Function(`return (async () => { ${interpolate(step.value, params)} })()`)();
        } catch (e) {
          console.warn("[webmcp-hub] evaluate step error:", e);
        }
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
    const el = deepQuery(option.selector) as HTMLInputElement | null;
    if (!el) return `Radio option element not found: ${option.selector}`;
    el.checked = true;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return null;
  }
  return fillField(field.selector, value);
}

/** Fill a DOM field. Returns an error message if the element was not found, or null on success. */
async function fillField(selector: string, value: unknown): Promise<string | null> {
  const el = deepQuery(selector) as HTMLElement | null;
  if (!el) return `Element not found: ${selector}`;

  // Contenteditable: the matched element itself may be a wrapper div —
  // check both the element and its first contenteditable child (e.g. X.com's tweet box).
  // Match any contenteditable value except explicit "false" to handle "true", "", and "plaintext-only".
  const editableEl = el.isContentEditable
    ? el
    : el.querySelector<HTMLElement>('[contenteditable]:not([contenteditable="false"])');

  if (editableEl) {
    editableEl.focus();

    // Select all existing content via the Selection API so the paste replaces it.
    const selectRange = document.createRange();
    selectRange.selectNodeContents(editableEl);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(selectRange);

    // Dispatch a paste event so rich-text editors (Lexical, Draft.js) process the text
    // through their own state machines. Direct innerHTML + input/beforeinput bypasses the
    // editor's internal EditorState, which is why submit buttons stay disabled even when
    // text appears in the box.
    const dt = new DataTransfer();
    dt.setData("text/plain", String(value));
    const pasteEvent = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    editableEl.dispatchEvent(pasteEvent);

    // If no editor handled the paste (event.defaultPrevented stays false), fall back to
    // direct DOM manipulation for plain contenteditable elements.
    if (!pasteEvent.defaultPrevented) {
      editableEl.innerHTML = "";
      editableEl.appendChild(document.createTextNode(String(value)));
      editableEl.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }),
      );
      // Move cursor to end — only needed for the plain contenteditable fallback;
      // rich-text editors (Lexical, Draft.js) manage their own cursor after paste.
      const range = document.createRange();
      range.selectNodeContents(editableEl);
      range.collapse(false);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }

    return null;
  }

  if (el instanceof HTMLSelectElement) {
    el.value = String(value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el instanceof HTMLInputElement && el.type === "checkbox") {
    el.checked = Boolean(value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el instanceof HTMLInputElement && el.type === "radio") {
    el.checked = true;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // Use the native prototype setter to bypass React's value property override.
    // Direct el.value = x calls React's setter which doesn't trigger state updates.
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(el, String(value));
    } else {
      el.value = String(value);
    }
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
      if (state === "visible" && el && isVisible(el)) return resolve();

      if (Date.now() - start > timeout) {
        return reject(new Error(`Timeout waiting for ${selector}`));
      }

      requestAnimationFrame(check);
    };

    check();
  });
}

async function waitForClickable(
  selector: string,
  params?: Record<string, unknown>,
  timeout = 5000,
): Promise<HTMLElement | null> {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      const el = query(selector, params) as HTMLElement | null;
      if (el) {
        const isEnabled = !(el as HTMLButtonElement).disabled;
        if (isVisible(el) && isEnabled) return resolve(el);
      }
      if (Date.now() - start > timeout) return resolve(null);
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

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const style = getComputedStyle(el);
  if (style.display === "none") return false;
  if (style.visibility === "hidden") return false;
  if (style.opacity === "0") return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  return true;
}

function checkState(el: Element | null, state: "visible" | "exists" | "hidden"): boolean {
  if (state === "hidden") return !el || !isVisible(el);
  if (state === "exists") return !!el;
  return !!el && isVisible(el);
}

function deepQuery(selector: string, root: Document | ShadowRoot = document): Element | null {
  const el = root.querySelector(selector);
  if (el) return el;
  for (const host of root.querySelectorAll("*")) {
    if (host.shadowRoot) {
      const found = deepQuery(selector, host.shadowRoot);
      if (found) return found;
    }
  }
  return null;
}

function deepQueryAll(selector: string, root: Document | ShadowRoot = document): Element[] {
  const results: Element[] = [...root.querySelectorAll(selector)];
  for (const host of root.querySelectorAll("*")) {
    if (host.shadowRoot) {
      results.push(...deepQueryAll(selector, host.shadowRoot));
    }
  }
  return results;
}

// Support :has-text("...") pseudo-selector (not native CSS).
// Handles both quote styles and escaped quotes inside the string (e.g. "it's done").
const HAS_TEXT_RE = /^(.+?):has-text\((?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\)\s*(.*)$/;

function normalizeText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function matchesText(el: Element, text: string): boolean {
  return normalizeText(el).includes(text.trim());
}

function query(selector: string, params?: Record<string, unknown>): Element | null {
  const resolved = params ? interpolate(selector, params) : selector;
  const match = resolved.match(HAS_TEXT_RE);
  if (!match) return deepQuery(resolved);

  const [, base, dq, sq, suffix] = match;
  const text = dq ?? sq;
  const els = deepQueryAll(base);
  for (const el of els) {
    if (matchesText(el, text)) {
      return suffix ? el.querySelector(suffix) : el;
    }
  }
  return null;
}

function queryAll(selector: string, params?: Record<string, unknown>): Element[] {
  const resolved = params ? interpolate(selector, params) : selector;
  const match = resolved.match(HAS_TEXT_RE);
  if (!match) return deepQueryAll(resolved);

  const [, base, dq, sq, suffix] = match;
  const text = dq ?? sq;
  const els = deepQueryAll(base);
  const results: Element[] = [];
  for (const el of els) {
    if (matchesText(el, text)) {
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
