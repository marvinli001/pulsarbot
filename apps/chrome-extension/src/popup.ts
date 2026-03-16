import {
  isHostAllowed,
  sendRuntimeMessage,
  type ExtensionExecutorState,
} from "./common.js";

let configDirty = false;

function elementById<T extends HTMLElement>(id: string) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing element: ${id}`);
  }
  return element as T;
}

function setStatus(message: string, tone: "info" | "success" | "warning" | "danger" = "info") {
  const element = elementById<HTMLDivElement>("status");
  element.textContent = message;
  element.className = tone === "info" ? "status" : `status ${tone}`;
}

function describeState(state: ExtensionExecutorState) {
  if (!state.serverUrl || !state.executorId) {
    return {
      headline: "Config needed",
      detail: "Fill the server URL and executor ID from the Mini App before pairing.",
    };
  }
  if (!state.executorToken) {
    return {
      headline: "Waiting for pair",
      detail: "Paste the short-lived pairing code from the Mini App, then click Pair.",
    };
  }
  if (state.attachState !== "attached") {
    return {
      headline: "Not attached yet",
      detail: "Bring the target tab to the front in Chrome, then click Attach Current Window.",
    };
  }
  if (!state.attachedOrigin) {
    return {
      headline: "Attached tab has no readable origin",
      detail: "Re-attach a normal web page with a visible URL before running browser workflows.",
    };
  }
  if (!isHostAllowed(state.attachedOrigin, state.allowedHosts)) {
    return {
      headline: "Attached site is outside allowed hosts",
      detail: "Update the executor allowlist in the Mini App or attach a tab that matches the allowlist.",
    };
  }
  return {
    headline: "Ready for browser actions",
    detail: `Attached to ${state.attachedOrigin}. You can now let Pulsarbot run browser workflows against this tab.`,
  };
}

function renderState(state: ExtensionExecutorState, forceConfigSync = false) {
  const pairButton = elementById<HTMLButtonElement>("pairButton");
  const heartbeatButton = elementById<HTMLButtonElement>("heartbeatButton");
  const attachButton = elementById<HTMLButtonElement>("attachButton");
  const detachButton = elementById<HTMLButtonElement>("detachButton");
  const summary = describeState(state);

  if (forceConfigSync || !configDirty) {
    elementById<HTMLInputElement>("serverUrl").value = state.serverUrl;
    elementById<HTMLInputElement>("executorId").value = state.executorId;
    elementById<HTMLTextAreaElement>("pairingCode").value = state.pairingCode ?? "";
    elementById<HTMLInputElement>("profileLabel").value = state.profileLabel ?? "";
    configDirty = false;
  }
  elementById<HTMLElement>("pairState").textContent = state.executorToken
    ? state.attachState === "attached"
      ? "Paired · Attached"
      : "Paired · Detached"
    : "Unpaired";
  elementById<HTMLDivElement>("stateSummary").textContent = `${summary.headline}: ${summary.detail}`;
  elementById<HTMLPreElement>("stateView").textContent = JSON.stringify({
    status: state.status,
    attachState: state.attachState,
    attachedUrl: state.attachedUrl,
    attachedOrigin: state.attachedOrigin,
    attachedWindowId: state.attachedWindowId,
    profileLabel: state.profileLabel,
    lastHeartbeatAt: state.lastHeartbeatAt,
    lastError: state.lastError,
    allowedHosts: state.allowedHosts,
  }, null, 2);

  pairButton.disabled = false;
  heartbeatButton.disabled = !state.executorToken;
  attachButton.disabled = !state.executorToken;
  detachButton.disabled = !state.executorToken || state.attachState !== "attached";
}

async function saveConfig() {
  return sendRuntimeMessage<ExtensionExecutorState>("save_config", {
    serverUrl: elementById<HTMLInputElement>("serverUrl").value,
    executorId: elementById<HTMLInputElement>("executorId").value,
    pairingCode: elementById<HTMLTextAreaElement>("pairingCode").value,
    profileLabel: elementById<HTMLInputElement>("profileLabel").value,
  });
}

async function refreshState(forceConfigSync = false) {
  const state = await sendRuntimeMessage<ExtensionExecutorState>("get_state");
  renderState(state, forceConfigSync);
  return state;
}

window.addEventListener("DOMContentLoaded", () => {
  const pairButton = elementById<HTMLButtonElement>("pairButton");
  const heartbeatButton = elementById<HTMLButtonElement>("heartbeatButton");
  const attachButton = elementById<HTMLButtonElement>("attachButton");
  const detachButton = elementById<HTMLButtonElement>("detachButton");
  const openOptions = elementById<HTMLAnchorElement>("openOptions");
  const configInputs = [
    elementById<HTMLInputElement>("serverUrl"),
    elementById<HTMLInputElement>("executorId"),
    elementById<HTMLTextAreaElement>("pairingCode"),
    elementById<HTMLInputElement>("profileLabel"),
  ];

  const runAction = async (message: string, action: () => Promise<unknown>) => {
    setStatus(message, "warning");
    try {
      await action();
      configDirty = false;
      await refreshState(true);
      setStatus("Done.", "success");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), "danger");
    }
  };

  for (const input of configInputs) {
    input.addEventListener("input", () => {
      configDirty = true;
    });
  }

  void refreshState(true).catch((error) => {
    setStatus(error instanceof Error ? error.message : String(error), "danger");
  });

  window.setInterval(() => {
    void refreshState().catch(() => {
      // Ignore transient refresh failures in the background polling loop.
    });
  }, 3_000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refreshState().catch(() => {
        // Ignore transient refresh failures when regaining focus.
      });
    }
  });

  pairButton.addEventListener("click", () => {
    void runAction("Pairing executor...", async () => {
      await saveConfig();
      await sendRuntimeMessage("pair_executor");
    });
  });

  heartbeatButton.addEventListener("click", () => {
    void runAction("Sending heartbeat...", async () => {
      await saveConfig();
      await sendRuntimeMessage("heartbeat_now");
    });
  });

  attachButton.addEventListener("click", () => {
    void runAction("Attaching browser window...", async () => {
      await saveConfig();
      await sendRuntimeMessage("attach_current_window");
    });
  });

  detachButton.addEventListener("click", () => {
    void runAction("Detaching browser window...", async () => {
      await sendRuntimeMessage("detach_executor");
    });
  });

  openOptions.addEventListener("click", (event) => {
    event.preventDefault();
    void sendRuntimeMessage("open_options").catch((error) => {
      setStatus(error instanceof Error ? error.message : String(error));
    });
  });
});
