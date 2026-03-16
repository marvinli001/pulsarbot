import { nowIso } from "./common.js";

declare global {
  interface Window {
    __PULSARBOT_CONTENT_SCRIPT_READY__?: boolean;
  }
}

const DEFAULT_SELECTOR_TIMEOUT_MS = 10_000;

function normalizeKey(rawKey: string) {
  if (rawKey === "Return") {
    return "Enter";
  }
  if (rawKey === "Esc") {
    return "Escape";
  }
  if (rawKey === "Space" || rawKey === "Spacebar") {
    return " ";
  }
  return rawKey;
}

function isElementVisible(element: HTMLElement) {
  if (element.hidden) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isElementDisabled(element: HTMLElement) {
  if (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLOptionElement ||
    element instanceof HTMLOptGroupElement ||
    element instanceof HTMLFieldSetElement
  ) {
    return element.disabled;
  }
  return element.getAttribute("aria-disabled") === "true";
}

function isEditableElement(element: HTMLElement) {
  if (element instanceof HTMLInputElement) {
    return !["button", "checkbox", "file", "hidden", "image", "radio", "reset", "submit"].includes(element.type);
  }
  if (element instanceof HTMLTextAreaElement) {
    return true;
  }
  return element.isContentEditable;
}

function scrollElementIntoView(element: HTMLElement) {
  element.scrollIntoView({
    block: "center",
    inline: "center",
    behavior: "auto",
  });
}

function queryElement(selector: string, options: {
  requireVisible?: boolean;
  requireEnabled?: boolean;
  requireEditable?: boolean;
} = {}): HTMLElement | null {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    return null;
  }
  if (options.requireVisible && !isElementVisible(element)) {
    return null;
  }
  if (options.requireEnabled && isElementDisabled(element)) {
    return null;
  }
  if (options.requireEditable && !isEditableElement(element)) {
    return null;
  }
  return element;
}

function waitForSelector(
  selector: string,
  timeoutMs = DEFAULT_SELECTOR_TIMEOUT_MS,
  options: {
    requireVisible?: boolean;
    requireEnabled?: boolean;
    requireEditable?: boolean;
  } = {},
) {
  return new Promise<HTMLElement>((resolve, reject) => {
    const startedAt = Date.now();
    const check = () => {
      const element = queryElement(selector, options);
      if (element) {
        resolve(element);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for selector: ${selector}`));
        return;
      }
      window.setTimeout(check, 120);
    };
    check();
  });
}

function createDomSnapshot() {
  const headingNodes = Array.from(document.querySelectorAll("h1, h2, h3"));
  const buttonNodes = Array.from(document.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']"));
  const linkNodes = Array.from(document.querySelectorAll("a[href]"));
  const inputNodes = Array.from(document.querySelectorAll("input, textarea, select"));
  const headings = headingNodes
    .slice(0, 20)
    .map((element) => ({
      tagName: element.tagName.toLowerCase(),
      text: element.textContent?.trim() ?? "",
    }));
  const buttons = buttonNodes
    .slice(0, 20)
    .map((element) => ({
      tagName: element.tagName.toLowerCase(),
      text: element.textContent?.trim() ?? "",
      disabled: "disabled" in element ? Boolean((element as HTMLButtonElement).disabled) : false,
    }));
  const links = linkNodes
    .slice(0, 20)
    .map((element) => ({
      text: element.textContent?.trim() ?? "",
      href: (element as HTMLAnchorElement).href,
    }));
  const inputs = inputNodes
    .slice(0, 20)
    .map((element) => ({
      tagName: element.tagName.toLowerCase(),
      type: (element as HTMLInputElement).type ?? null,
      name: (element as HTMLInputElement).name ?? null,
      placeholder: (element as HTMLInputElement).placeholder ?? null,
      valueLength: "value" in element ? String((element as HTMLInputElement).value ?? "").length : 0,
    }));

  return {
    url: window.location.href,
    origin: window.location.origin,
    title: document.title,
    capturedAt: nowIso(),
    headings,
    buttons,
    links,
    inputs,
    bodyTextExcerpt: document.body?.innerText?.replace(/\s+/g, " ").slice(0, 4_000) ?? "",
  };
}

function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  nextValue: string,
) {
  const prototype = element instanceof HTMLInputElement
    ? HTMLInputElement.prototype
    : HTMLTextAreaElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) {
    descriptor.set.call(element, nextValue);
    return;
  }
  element.value = nextValue;
}

function setElementValue(element: HTMLElement, nextValue: string, inputType = "insertText") {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.focus();
    setNativeValue(element, nextValue);
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: nextValue,
      inputType,
    }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (element.isContentEditable) {
    element.focus();
    element.textContent = nextValue;
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: nextValue,
      inputType,
    }));
    return;
  }
  throw new Error("Target element is not editable");
}

function readElementValue(element: HTMLElement) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value ?? "";
  }
  if (element.isContentEditable) {
    return element.textContent ?? "";
  }
  throw new Error("Target element is not editable");
}

function setSelectionToEnd(element: HTMLElement) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const nextPosition = element.value.length;
    element.setSelectionRange(nextPosition, nextPosition);
    return;
  }
  if (element.isContentEditable) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
}

function keyboardEventInit(key: string): KeyboardEventInit {
  const normalizedKey = normalizeKey(key);
  const keyMap: Record<string, { code: string; keyCode: number }> = {
    Enter: { code: "Enter", keyCode: 13 },
    Tab: { code: "Tab", keyCode: 9 },
    Escape: { code: "Escape", keyCode: 27 },
    Backspace: { code: "Backspace", keyCode: 8 },
    Delete: { code: "Delete", keyCode: 46 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    " ": { code: "Space", keyCode: 32 },
  };
  const mapped = keyMap[normalizedKey];
  if (mapped) {
    return {
      key: normalizedKey,
      code: mapped.code,
      keyCode: mapped.keyCode,
      which: mapped.keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
  }
  if (normalizedKey.length === 1) {
    const upper = normalizedKey.toUpperCase();
    const isLetter = /[A-Z]/.test(upper);
    const isDigit = /[0-9]/.test(normalizedKey);
    const code = isLetter
      ? `Key${upper}`
      : isDigit
        ? `Digit${normalizedKey}`
        : "Unidentified";
    const keyCode = normalizedKey.charCodeAt(0);
    return {
      key: normalizedKey,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
  }
  return {
    key: normalizedKey,
    code: normalizedKey,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
}

function isButtonLikeElement(element: HTMLElement) {
  return (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLAnchorElement ||
    (element instanceof HTMLInputElement
      && ["button", "checkbox", "radio", "submit"].includes(element.type)) ||
    element.getAttribute("role") === "button"
  );
}

function maybeSubmitForm(element: HTMLElement) {
  const form = element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLButtonElement ||
    element instanceof HTMLSelectElement
    ? element.form
    : element.closest("form");
  if (form instanceof HTMLFormElement) {
    const submitEvent = typeof SubmitEvent === "function"
      ? new SubmitEvent("submit", { bubbles: true, cancelable: true })
      : new Event("submit", { bubbles: true, cancelable: true });
    const shouldContinueWithNativeSubmit = form.dispatchEvent(submitEvent);
    if (shouldContinueWithNativeSubmit) {
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        form.submit();
      }
    }
    return true;
  }
  return false;
}

function insertTextIntoEditable(element: HTMLElement, text: string) {
  const currentValue = readElementValue(element);
  setElementValue(element, `${currentValue}${text}`, text === "\n" ? "insertLineBreak" : "insertText");
  setSelectionToEnd(element);
}

function applyDefaultKeyAction(element: HTMLElement, key: string) {
  const normalizedKey = normalizeKey(key);
  if (normalizedKey === "Enter") {
    if (element instanceof HTMLTextAreaElement || element.isContentEditable) {
      insertTextIntoEditable(element, "\n");
      return true;
    }
    if (isButtonLikeElement(element)) {
      element.click();
      return true;
    }
    return maybeSubmitForm(element);
  }
  if (normalizedKey === " " && isButtonLikeElement(element)) {
    element.click();
    return true;
  }
  if (normalizedKey.length === 1 && isEditableElement(element)) {
    insertTextIntoEditable(element, normalizedKey);
    return true;
  }
  return false;
}

function dispatchPointerClick(element: HTMLElement) {
  scrollElementIntoView(element);
  element.focus();
  const rect = element.getBoundingClientRect();
  const baseInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + Math.min(rect.width / 2, Math.max(rect.width - 1, 1)),
    clientY: rect.top + Math.min(rect.height / 2, Math.max(rect.height - 1, 1)),
  };
  if (typeof window.PointerEvent === "function") {
    element.dispatchEvent(new PointerEvent("pointerdown", {
      ...baseInit,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
    }));
  }
  element.dispatchEvent(new MouseEvent("mousedown", {
    ...baseInit,
    button: 0,
    buttons: 1,
  }));
  if (typeof window.PointerEvent === "function") {
    element.dispatchEvent(new PointerEvent("pointerup", {
      ...baseInit,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 0,
    }));
  }
  element.dispatchEvent(new MouseEvent("mouseup", {
    ...baseInit,
    button: 0,
    buttons: 0,
  }));
  element.click();
}

export async function handleMessage(message: Record<string, unknown>) {
  switch (message.type) {
    case "ping":
      return { ok: true };
    case "snapshot_dom":
      return createDomSnapshot();
    case "click": {
      const selector = String(message.selector ?? "");
      const element = await waitForSelector(selector, Number(message.timeoutMs ?? DEFAULT_SELECTOR_TIMEOUT_MS), {
        requireVisible: true,
        requireEnabled: true,
      });
      dispatchPointerClick(element);
      return { clicked: true };
    }
    case "type": {
      const selector = String(message.selector ?? "");
      const element = await waitForSelector(selector, Number(message.timeoutMs ?? DEFAULT_SELECTOR_TIMEOUT_MS), {
        requireVisible: true,
        requireEnabled: true,
        requireEditable: true,
      });
      const clear = message.clear !== false;
      const text = String(message.text ?? "");
      const baseValue = clear ? "" : readElementValue(element);
      setElementValue(element, `${baseValue}${text}`);
      setSelectionToEnd(element);
      return { typed: true };
    }
    case "wait_for_selector": {
      const selector = String(message.selector ?? "");
      await waitForSelector(selector, Number(message.timeoutMs ?? DEFAULT_SELECTOR_TIMEOUT_MS), {
        requireVisible: true,
      });
      return { ready: true };
    }
    case "extract_text": {
      const selector = String(message.selector ?? "");
      const element = queryElement(selector);
      if (!element) {
        throw new Error(`Could not find selector: ${selector}`);
      }
      return element.innerText;
    }
    case "press": {
      const key = normalizeKey(String(message.key ?? ""));
      const selector = typeof message.selector === "string" && message.selector.trim()
        ? String(message.selector)
        : null;
      const target = selector
        ? await waitForSelector(selector, Number(message.timeoutMs ?? DEFAULT_SELECTOR_TIMEOUT_MS), {
            requireVisible: true,
            requireEnabled: true,
          })
        : document.activeElement;
      if (!(target instanceof HTMLElement)) {
        throw new Error("Could not find a target element for key press");
      }
      scrollElementIntoView(target);
      target.focus();
      const eventInit = keyboardEventInit(key);
      const keydownAllowed = target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
      const shouldDispatchKeypress = key === "Enter" || key === " " || key.length === 1;
      const keypressAllowed = shouldDispatchKeypress
        ? target.dispatchEvent(new KeyboardEvent("keypress", eventInit))
        : true;
      if (keydownAllowed && keypressAllowed) {
        applyDefaultKeyAction(target, key);
      }
      target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
      return { pressed: true };
    }
    default:
      throw new Error(`Unsupported content-script message: ${String(message.type ?? "unknown")}`);
  }
}

if (!window.__PULSARBOT_CONTENT_SCRIPT_READY__) {
  window.__PULSARBOT_CONTENT_SCRIPT_READY__ = true;
  chrome.runtime.onMessage.addListener((message: Record<string, unknown>, _sender: unknown, sendResponse: (payload: unknown) => void) => {
    void handleMessage(message)
      .then((result) => {
        sendResponse({
          ok: true,
          result,
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  });
}
