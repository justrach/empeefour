// Clean home page. Lists recent takes, hosts the primary voice-mode CTA,
// and links into the advanced editor at /debug.

const grid = document.getElementById("home-runs-grid");
const countEl = document.getElementById("home-runs-count");
const voiceBtn = document.getElementById("home-voice");
const voiceLabel = voiceBtn.querySelector(".home-voice-label");

let runs = [];
let voiceActive = false;

function pluralize(n, single, plural) {
  return n === 1 ? `1 ${single}` : `${n} ${plural || single + "s"}`;
}

async function loadRuns() {
  try {
    const res = await fetch("/api/runs").then((r) => r.json());
    runs = res.runs || [];
    countEl.textContent = pluralize(runs.length, "take");
    renderRuns();
  } catch (err) {
    grid.innerHTML = `<div class="home-run-empty">Couldn't load runs: ${err.message}</div>`;
  }
}

function renderRuns() {
  if (runs.length === 0) {
    grid.innerHTML =
      '<div class="home-run-empty">No takes yet. Hit <strong>Start Voice Mode</strong> above to record your first one.</div>';
    return;
  }
  grid.innerHTML = "";
  for (const run of runs) {
    const card = document.createElement("a");
    card.className = "home-run-card";
    card.href = `/debug#run=${encodeURIComponent(run.name)}`;
    card.dataset.run = run.name;

    let thumb;
    if (run.final) {
      thumb = document.createElement("video");
      thumb.className = "home-run-thumb";
      thumb.src = `/media/runs/${encodeURIComponent(run.name)}/final.mp4`;
      thumb.muted = true;
      thumb.preload = "metadata";
      thumb.playsInline = true;
      thumb.loop = true;
    } else if (run.raw) {
      thumb = document.createElement("video");
      thumb.className = "home-run-thumb";
      thumb.src = `/media/runs/${encodeURIComponent(run.name)}/raw.mov`;
      thumb.muted = true;
      thumb.preload = "metadata";
      thumb.playsInline = true;
    } else {
      thumb = document.createElement("div");
      thumb.className = "home-run-thumb no-final";
      thumb.textContent = "No video yet";
    }

    const meta = document.createElement("div");
    meta.className = "home-run-meta";
    const badges = [];
    if (run.final) badges.push('<span class="home-run-badge final">Rendered</span>');
    else if (run.raw) badges.push('<span class="home-run-badge raw">Raw</span>');
    meta.innerHTML = `
      <div class="home-run-name">${run.name}</div>
      <div class="home-run-stats">
        <span>${pluralize(run.events, "mark")}</span>
        ${badges.join("")}
      </div>
    `;

    card.appendChild(thumb);
    card.appendChild(meta);
    grid.appendChild(card);
  }
}

function setVoiceUi(active) {
  voiceActive = active;
  voiceBtn.classList.toggle("active", active);
  voiceLabel.textContent = active ? "Stop Voice Mode" : "Start Voice Mode";
}

if (window.studio) {
  window.studio.getVoiceState().then((s) => setVoiceUi(!!s.active));
  window.studio.onListenState((s) => setVoiceUi(!!s.active));
  voiceBtn.addEventListener("click", async () => {
    try {
      const result = await window.studio.toggleVoice();
      setVoiceUi(result.active);
    } catch (err) {
      console.error("voice toggle failed", err);
    }
  });
} else {
  // Browser fallback (not Electron) — voice IPC isn't available.
  voiceBtn.addEventListener("click", () => {
    document.getElementById("home-hint").textContent =
      "Voice Mode runs in the desktop app. Open Studio Agent in Electron to use it.";
  });
}

// Spacebar = toggle play on the hovered card video, or first card if nothing hovered.
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || tag === "button") return;
  e.preventDefault();
  const hovered = document.querySelector(".home-run-card:hover video");
  const v = hovered || document.querySelector(".home-run-card video");
  if (v) {
    v.paused ? v.play() : v.pause();
  }
});

// Hover plays a soft preview loop.
document.addEventListener("pointerenter", (e) => {
  if (e.target?.tagName === "VIDEO" && e.target.classList.contains("home-run-thumb")) {
    e.target.play().catch(() => {});
  }
}, true);
document.addEventListener("pointerleave", (e) => {
  if (e.target?.tagName === "VIDEO" && e.target.classList.contains("home-run-thumb")) {
    e.target.pause();
    e.target.currentTime = 0;
  }
}, true);

loadRuns();
setInterval(loadRuns, 5000);
