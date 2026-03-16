import {
  sendRuntimeMessage,
  type ExtensionExecutorState,
} from "./common.js";

const stateView = document.getElementById("stateView");

async function renderState() {
  const state = await sendRuntimeMessage<ExtensionExecutorState>("get_state");
  if (stateView) {
    stateView.textContent = JSON.stringify(state, null, 2);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  void renderState();
});
