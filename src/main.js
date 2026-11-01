const { invoke } = window.__TAURI__.core;

async function refreshBoot() {
  const stateEl = document.querySelector("#boot-state");
  const detailEl = document.querySelector("#boot-detail");
  try {
    const state = await invoke("get_boot_state");
    stateEl.textContent = state.ready
      ? `Boot: ready — ${state.url}`
      : "Boot: starting…";
    detailEl.textContent = `pid ${state.pid} · protocol ${state.protocol_version}`;
  } catch (e) {
    stateEl.textContent = "Boot: error";
    detailEl.textContent = String(e);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  refreshBoot();
  setInterval(refreshBoot, 2000);
});
