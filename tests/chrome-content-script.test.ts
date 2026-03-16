// @vitest-environment jsdom

import { beforeAll, beforeEach, expect, it, vi } from "vitest";

let handleMessage: typeof import("../apps/chrome-extension/src/content-script.js").handleMessage;

function makeVisible(element: Element | null) {
  if (!(element instanceof HTMLElement)) {
    throw new Error("Expected HTMLElement");
  }
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 240,
      bottom: 48,
      width: 240,
      height: 48,
      toJSON: () => ({}),
    }),
  });
  return element;
}

beforeAll(async () => {
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: {
        addListener: vi.fn(),
      },
    },
  });
  if (typeof window.PointerEvent !== "function") {
    vi.stubGlobal("PointerEvent", MouseEvent);
  }
  if (typeof HTMLElement.prototype.scrollIntoView !== "function") {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  }
  ({ handleMessage } = await import("../apps/chrome-extension/src/content-script.ts"));
});

beforeEach(() => {
  document.body.innerHTML = "";
});

it("submits forms when press Enter targets an input", async () => {
  document.body.innerHTML = `
    <form id="name-form">
      <input id="name-input" />
      <button id="submit-button" type="submit">Submit</button>
    </form>
    <div id="result" data-state="waiting">Waiting</div>
  `;

  const form = document.getElementById("name-form");
  const input = makeVisible(document.getElementById("name-input"));
  const result = document.getElementById("result");
  makeVisible(document.getElementById("submit-button"));
  makeVisible(result);

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (result instanceof HTMLElement && input instanceof HTMLInputElement) {
      result.dataset.state = "submitted";
      result.textContent = `Hello ${input.value}`;
    }
  });

  await handleMessage({
    type: "type",
    selector: "#name-input",
    text: "Pulsarbot",
  });
  await handleMessage({
    type: "press",
    selector: "#name-input",
    key: "Enter",
  });

  expect(result?.getAttribute("data-state")).toBe("submitted");
  expect(result?.textContent).toBe("Hello Pulsarbot");
});

it("dispatches pointer and mouse phases before click", async () => {
  document.body.innerHTML = `
    <button id="pointer-action" type="button">Pointer Action</button>
    <div id="pointer-result" data-state="waiting">Waiting</div>
  `;

  const button = makeVisible(document.getElementById("pointer-action"));
  const result = document.getElementById("pointer-result");
  makeVisible(result);
  const events: string[] = [];

  for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    button.addEventListener(eventName, () => {
      events.push(eventName);
    });
  }
  button.addEventListener("click", () => {
    if (result instanceof HTMLElement) {
      result.dataset.state = events.includes("pointerdown") &&
        events.includes("mousedown") &&
        events.includes("pointerup") &&
        events.includes("mouseup")
        ? "clicked"
        : "missing-pointer";
    }
  });

  await handleMessage({
    type: "click",
    selector: "#pointer-action",
  });

  expect(events).toEqual(expect.arrayContaining([
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
  ]));
  expect(result?.getAttribute("data-state")).toBe("clicked");
});

it("appends to contentEditable fields when clear is false", async () => {
  document.body.innerHTML = `
    <div id="editor" contenteditable="true">Hello</div>
  `;

  const editor = makeVisible(document.getElementById("editor"));
  Object.defineProperty(editor, "isContentEditable", {
    configurable: true,
    value: true,
  });

  await handleMessage({
    type: "type",
    selector: "#editor",
    text: " world",
    clear: false,
  });

  expect(editor.textContent).toBe("Hello world");
});
