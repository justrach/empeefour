let runs = [];
let selectedRun = null;
let eventsDoc = null;
let livePollHandle = null;
let voiceActive = false;

const $ = (id) => document.getElementById(id);

function bind(id, event, handler) {
  const element = $(id);
  if (element) element.addEventListener(event, handler);
}

function setStatus(text) {
  $("status").textContent = text;
}

function value(id) {
  return $(id).value;
}

function numericValue(id, fallback = 0) {
  const parsed = Number(value(id));
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || response.statusText);
  }
  return payload;
}

function eventLabel(event) {
  if (event.type === "caption") return event.text || "Caption";
  if (event.type === "speed") return `${event.start}s-${event.end}s at ${event.factor}x`;
  if (event.label) return event.label;
  if ("x" in event && "y" in event) return `x ${event.x}, y ${event.y}`;
  return "";
}

function renderRuns() {
  const host = $("runs");
  host.innerHTML = "";
  for (const run of runs) {
    const button = document.createElement("button");
    button.className = `run ${selectedRun === run.name ? "active" : ""}`;
    button.innerHTML = `<strong>${run.name}</strong><small>${run.events} events - raw ${run.raw ? "yes" : "no"} - final ${run.final ? "yes" : "no"}</small>`;
    button.addEventListener("click", () => selectRun(run.name));
    host.appendChild(button);
  }
}

async function refreshStatus() {
  const payload = await api("/api/status");
  const active = payload.active;
  $("record-status").textContent = active ? `Recording ${active.run_dir.split("/").at(-1)}` : "Idle";
  $("start-record").disabled = Boolean(active);
  $("stop-record").disabled = !active;
  if (active) {
    const liveName = active.run_dir.split("/").at(-1);
    if (selectedRun !== liveName) selectedRun = liveName;
    startLivePolling(liveName);
  } else {
    stopLivePolling();
  }
}

function startLivePolling(runName) {
  if (livePollHandle) return;
  livePollHandle = setInterval(async () => {
    try {
      const next = await api(`/api/runs/${encodeURIComponent(runName)}/events`);
      const prevCount = eventsDoc?.events?.length || 0;
      eventsDoc = next;
      syncEditor();
      const newCount = next.events?.length || 0;
      if (newCount > prevCount) {
        const fresh = next.events.slice(prevCount);
        for (const ev of fresh) {
          appendVoiceLog(`+ ${ev.type} @ ${Number(ev.time || 0).toFixed(1)}s ${ev.label || ev.text || ""}`);
        }
      }
    } catch (err) {
      // tolerate transient errors during polling
    }
  }, 750);
}

function stopLivePolling() {
  if (livePollHandle) {
    clearInterval(livePollHandle);
    livePollHandle = null;
  }
}

function appendVoiceLog(line) {
  const host = $("voice-log");
  if (!host || host.hidden) return;
  const row = document.createElement("div");
  row.textContent = line;
  host.appendChild(row);
  while (host.childNodes.length > 30) host.removeChild(host.firstChild);
  host.scrollTop = host.scrollHeight;
}

function mediaUrl(runName, fileName) {
  return `/media/runs/${encodeURIComponent(runName)}/${fileName}`;
}

function renderVideoPanel() {
  const run = runs.find((item) => item.name === selectedRun);
  const video = $("preview-video");
  const finalLink = $("final-link");
  const rawLink = $("raw-link");

  if (!run) {
    video.removeAttribute("src");
    video.load();
    $("video-status").textContent = "Select a run with a final render.";
    finalLink.removeAttribute("href");
    rawLink.removeAttribute("href");
    return;
  }

  finalLink.href = run.final ? mediaUrl(run.name, "final.mp4") : "#";
  rawLink.href = run.raw ? mediaUrl(run.name, "raw.mov") : "#";

  if (run.final) {
    const url = `${mediaUrl(run.name, "final.mp4")}?t=${Date.now()}`;
    if (!video.src.endsWith(url)) {
      video.src = url;
      video.load();
    }
    $("video-status").textContent = "Final render is ready.";
  } else if (run.raw) {
    video.src = `${mediaUrl(run.name, "raw.mov")}?t=${Date.now()}`;
    video.load();
    $("video-status").textContent = "No final render yet. Showing raw recording.";
  } else {
    video.removeAttribute("src");
    video.load();
    $("video-status").textContent = "No video files for this run yet.";
  }
}

let editingIndex = null;

function eventEnd(event) {
  const t = Number(event.time || 0);
  if (event.type === "speed" || event.type === "cut") {
    return Number(event.end || event.start || t);
  }
  if (event.type === "caption" || event.type === "zoom" || event.type === "click") {
    return t + Number(event.duration || 0);
  }
  return t + 0.2;
}

function timelineDuration() {
  // When a video is loaded, the timeline matches its duration exactly.
  // Events that extend past the video won't render in final.mp4, so
  // letting them stretch the strip would hide that bug; clipping them
  // visually is a more useful signal.
  const video = $("preview-video");
  const vd = Number(video?.duration);
  if (Number.isFinite(vd) && vd > 0) return Math.max(vd, 1);
  // No video yet — fall back to fitting the events.
  const events = eventsDoc?.events || [];
  let max = 0;
  for (const e of events) max = Math.max(max, eventEnd(e));
  return Math.max(max, 5);
}

function pickTickStep(duration) {
  if (duration <= 6) return 1;
  if (duration <= 15) return 2;
  if (duration <= 40) return 5;
  if (duration <= 90) return 10;
  return 30;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const totalSec = Math.floor(seconds);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderRuler(duration) {
  const ruler = $("strip-ruler");
  ruler.innerHTML = "";
  const step = pickTickStep(duration);
  for (let t = 0; t <= duration + 0.001; t += step) {
    const tick = document.createElement("div");
    tick.className = "tick major";
    tick.style.left = `${(t / duration) * 100}%`;
    ruler.appendChild(tick);
    const label = document.createElement("div");
    label.className = "label";
    label.style.left = `${(t / duration) * 100}%`;
    label.textContent = formatTime(t);
    ruler.appendChild(label);
  }
}

function chipClassFor(event) {
  return `chip-${event.type || "marker"}`;
}

function chipText(event) {
  if (event.type === "caption") return event.text || "caption";
  if (event.type === "speed") return `${Number(event.factor || 1).toFixed(1)}x`;
  if (event.type === "cut") return "cut";
  if (event.label) return event.label;
  return event.type || "event";
}

function laneIdFor(event) {
  if (event.type === "caption") return "lane-caption";
  if (event.type === "speed" || event.type === "cut") return "lane-span";
  return "lane-mark"; // zoom, click, marker
}

function renderTimelineStrip(duration) {
  const lanes = ["lane-caption", "lane-mark", "lane-span"];
  for (const id of lanes) {
    const el = $(id);
    if (el) el.innerHTML = "";
  }
  const events = eventsDoc?.events || [];
  events.forEach((event, index) => {
    const lane = $(laneIdFor(event));
    if (!lane) return;
    const chip = document.createElement("div");
    chip.className = `chip ${chipClassFor(event)}`;
    chip.dataset.index = String(index);
    chip.title = `${event.type} @ ${formatTime(Number(event.time || 0))}${event.label ? " - " + event.label : ""}`;
    const start = Number(event.time || 0);
    const end = eventEnd(event);
    const isSpan = event.type === "speed" || event.type === "cut" ||
      (event.duration && (event.type === "caption"));
    if (isSpan) {
      chip.classList.add("span");
      chip.style.left = `${(start / duration) * 100}%`;
      chip.style.width = `${Math.max(((end - start) / duration) * 100, 1.5)}%`;
    } else {
      chip.style.left = `${(start / duration) * 100}%`;
    }
    chip.textContent = chipText(event);
    if (editingIndex === index) chip.classList.add("active");
    attachChipDrag(chip, index, duration);
    lane.appendChild(chip);
  });
}

function attachChipDrag(chip, index, duration) {
  chip.style.cursor = "grab";
  chip.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const strip = $("strip-tracks") || $("timeline-strip");
    const rect = strip.getBoundingClientRect();
    const event = eventsDoc.events[index];
    if (!event) return;
    const startX = e.clientX;
    const isSpan = event.type === "speed" || event.type === "cut" ||
      (event.type === "caption" && event.duration);
    const span = isSpan
      ? Math.max(0.05, Number((event.end ?? (Number(event.start || 0) + Number(event.duration || 0.5))) - Number(event.start ?? event.time ?? 0)))
      : 0;
    const originalTime = Number(event.time ?? event.start ?? 0);
    const initialLeft = parseFloat(chip.style.left) || 0;
    let dragging = false;
    chip.setPointerCapture(e.pointerId);
    chip.classList.add("dragging");
    showTooltip();

    function ratioFromClient(clientX) {
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    }
    function snapTime(t) {
      const snapped = Math.round(t * 10) / 10;
      const maxStart = isSpan ? Math.max(0, duration - span) : duration;
      return Math.max(0, Math.min(maxStart, snapped));
    }
    function showTooltip() {
      let tip = document.getElementById("chip-tooltip");
      if (!tip) {
        tip = document.createElement("div");
        tip.id = "chip-tooltip";
        tip.className = "chip-tooltip";
        document.body.appendChild(tip);
      }
      tip.hidden = false;
      tip.textContent = `${event.type} @ ${originalTime.toFixed(2)}s`;
      const r = chip.getBoundingClientRect();
      tip.style.left = `${r.left + r.width / 2}px`;
      tip.style.top = `${r.top - 8}px`;
    }
    function updateTooltip(t) {
      const tip = document.getElementById("chip-tooltip");
      if (!tip) return;
      tip.textContent = `${event.type} @ ${t.toFixed(2)}s${isSpan ? "  (Δ " + span.toFixed(2) + "s)" : ""}`;
      const r = chip.getBoundingClientRect();
      tip.style.left = `${r.left + r.width / 2}px`;
      tip.style.top = `${r.top - 8}px`;
    }
    function hideTooltip() {
      const tip = document.getElementById("chip-tooltip");
      if (tip) tip.hidden = true;
    }

    function onMove(ev) {
      const dx = ev.clientX - startX;
      if (!dragging && Math.abs(dx) > 5) {
        dragging = true;
        chip.style.cursor = "grabbing";
      }
      if (!dragging) return;
      const newTime = snapTime(ratioFromClient(ev.clientX) * duration);
      chip.style.left = `${(newTime / duration) * 100}%`;
      chip.dataset.dragTime = String(newTime);
      updateTooltip(newTime);
    }
    function onUp(ev) {
      chip.removeEventListener("pointermove", onMove);
      chip.removeEventListener("pointerup", onUp);
      chip.removeEventListener("pointercancel", onUp);
      try { chip.releasePointerCapture(ev.pointerId); } catch {}
      chip.classList.remove("dragging");
      chip.style.cursor = "grab";
      hideTooltip();
      if (!dragging) {
        focusEvent(index, { scroll: true, edit: true });
        return;
      }
      const newTime = Number(chip.dataset.dragTime || originalTime);
      if (isSpan) {
        event.start = newTime;
        event.end = Math.round((newTime + span) * 1000) / 1000;
        event.time = newTime;
      } else {
        event.time = newTime;
      }
      delete chip.dataset.dragTime;
      syncEditor();
    }
    chip.addEventListener("pointermove", onMove);
    chip.addEventListener("pointerup", onUp);
    chip.addEventListener("pointercancel", onUp);
  });
}

function updateStripCursor() {
  const cursor = $("strip-cursor");
  const strip = $("timeline-strip");
  if (!cursor || !strip) return;
  const video = $("preview-video");
  const duration = timelineDuration();
  const hasMedia = video && Number.isFinite(video.duration) && video.duration > 0;
  strip.dataset.noMedia = hasMedia ? "false" : "true";
  if (!hasMedia) {
    cursor.hidden = true;
    return;
  }
  cursor.hidden = false;
  const t = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  cursor.style.left = `${(t / duration) * 100}%`;
}

function focusEvent(index, { scroll = false, edit = false } = {}) {
  editingIndex = edit ? index : editingIndex;
  renderTimeline();
  renderTimelineStrip(timelineDuration());
  if (scroll) {
    const row = document.querySelector(`.event[data-index="${index}"]`);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function renderTimeline() {
  const events = eventsDoc?.events || [];
  $("event-count").textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
  const timeline = $("timeline");
  timeline.innerHTML = "";
  events.forEach((event, index) => {
    const row = document.createElement("div");
    row.className = "event";
    row.dataset.index = String(index);
    if (editingIndex === index) {
      row.classList.add("editing");
      row.appendChild(buildEditor(event, index));
    } else {
      row.appendChild(buildSummary(event, index));
    }
    timeline.appendChild(row);
  });
}

function buildSummary(event, index) {
  const wrap = document.createElement("div");
  wrap.className = "row-summary";
  const type = document.createElement("strong");
  type.textContent = event.type || "event";
  const desc = document.createElement("span");
  desc.textContent = `${Number(event.time || 0).toFixed(3)}s - ${eventLabel(event)}`;
  const buttons = document.createElement("div");
  buttons.className = "row-buttons";
  const editBtn = document.createElement("button");
  editBtn.textContent = "Edit";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    editingIndex = index;
    renderTimeline();
    renderTimelineStrip(timelineDuration());
  });
  const delBtn = document.createElement("button");
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    eventsDoc.events.splice(index, 1);
    if (editingIndex === index) editingIndex = null;
    syncEditor();
  });
  buttons.appendChild(editBtn);
  buttons.appendChild(delBtn);
  wrap.appendChild(type);
  wrap.appendChild(desc);
  wrap.appendChild(buttons);
  return wrap;
}

function fieldsForType(type) {
  const common = [{ key: "time", label: "Time", step: 0.1 }];
  if (type === "zoom" || type === "click") {
    return common.concat([
      { key: "x", label: "X", step: 1 },
      { key: "y", label: "Y", step: 1 },
      { key: "scale", label: "Scale", step: 0.05 },
      { key: "duration", label: "Duration", step: 0.1 },
      { key: "label", label: "Label", text: true },
    ]);
  }
  if (type === "caption") {
    return common.concat([
      { key: "text", label: "Text", text: true, wide: true },
      { key: "duration", label: "Duration", step: 0.1 },
      { key: "position", label: "Position", select: ["bottom", "top"] },
    ]);
  }
  if (type === "speed") {
    return [
      { key: "start", label: "Start", step: 0.1 },
      { key: "end", label: "End", step: 0.1 },
      { key: "factor", label: "Factor", step: 0.1 },
      { key: "label", label: "Label", text: true },
    ];
  }
  if (type === "cut") {
    return [
      { key: "start", label: "Start", step: 0.1 },
      { key: "end", label: "End", step: 0.1 },
      { key: "label", label: "Label", text: true },
    ];
  }
  return common.concat([{ key: "label", label: "Label", text: true }]);
}

function buildEditor(event, index) {
  const editor = document.createElement("div");
  editor.className = "editor";
  const fields = fieldsForType(event.type);
  const inputs = {};
  for (const f of fields) {
    const wrap = document.createElement("label");
    wrap.textContent = f.label;
    let input;
    if (f.select) {
      input = document.createElement("select");
      for (const v of f.select) {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        input.appendChild(opt);
      }
      input.value = String(event[f.key] ?? f.select[0]);
    } else if (f.text) {
      input = document.createElement("input");
      input.type = "text";
      input.value = String(event[f.key] ?? "");
    } else {
      input = document.createElement("input");
      input.type = "number";
      if (f.step) input.step = String(f.step);
      input.value = String(event[f.key] ?? 0);
    }
    inputs[f.key] = { input, field: f };
    wrap.appendChild(input);
    editor.appendChild(wrap);
  }
  const actions = document.createElement("div");
  actions.className = "row-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    editingIndex = null;
    renderTimeline();
    renderTimelineStrip(timelineDuration());
  });
  const applyBtn = document.createElement("button");
  applyBtn.textContent = "Apply";
  applyBtn.className = "primary";
  applyBtn.addEventListener("click", () => {
    const updated = { ...event };
    for (const [key, { input, field }] of Object.entries(inputs)) {
      if (field.text || field.select) {
        const v = input.value.trim();
        if (v === "" && (field.key === "label" || field.key === "text")) {
          delete updated[key];
        } else {
          updated[key] = v;
        }
      } else {
        updated[key] = Number(input.value);
      }
    }
    if (event.type === "speed" || event.type === "cut") {
      updated.time = Number(updated.start ?? updated.time ?? 0);
    }
    eventsDoc.events[index] = updated;
    editingIndex = null;
    syncEditor();
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(applyBtn);
  editor.appendChild(actions);
  return editor;
}

function syncEditor() {
  if (eventsDoc) {
    eventsDoc.events.sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
  }
  $("json-editor").value = JSON.stringify(eventsDoc || { events: [] }, null, 2);
  const duration = timelineDuration();
  renderRuler(duration);
  renderTimelineStrip(duration);
  renderTimeline();
  updateStripCursor();
}

function runFromHash() {
  const m = (location.hash || "").match(/run=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function refreshRuns() {
  setStatus("Loading");
  const payload = await api("/api/runs");
  runs = payload.runs;
  // Honor /debug#run=<name> deep links from the home page.
  const hashRun = runFromHash();
  if (hashRun && runs.find((r) => r.name === hashRun)) {
    selectedRun = hashRun;
  } else if (!selectedRun && runs.length) {
    selectedRun = runs[0].name;
  }
  renderRuns();
  renderVideoPanel();
  if (selectedRun) await selectRun(selectedRun);
  setStatus("Idle");
}

async function selectRun(name) {
  selectedRun = name;
  renderRuns();
  renderVideoPanel();
  $("run-title").textContent = name;
  $("run-meta").textContent = `/runs/${name}`;
  eventsDoc = await api(`/api/runs/${encodeURIComponent(name)}/events`);
  syncEditor();
}

function parseEditor() {
  const parsed = JSON.parse($("json-editor").value);
  if (!Array.isArray(parsed.events)) throw new Error("JSON must include an events array.");
  eventsDoc = parsed;
  syncEditor();
}

function addEvent(type) {
  if (!eventsDoc) eventsDoc = { version: 1, recording: {}, events: [] };
  const last = eventsDoc.events.at(-1);
  const time = last ? Number(last.time || 0) + 1 : 1;
  if (type === "click") {
    eventsDoc.events.push({ type, time, x: 900, y: 520, scale: 1.35, duration: 1.4, lead: 0.25, zoom: true });
  } else if (type === "zoom") {
    eventsDoc.events.push({ type, time, x: 900, y: 520, scale: 1.45, duration: 1.5, lead: 0.25 });
  } else if (type === "speed") {
    eventsDoc.events.push({ type, time, start: time, end: time + 2.5, factor: 2.5, label: "Speed through typing" });
  } else if (type === "caption") {
    eventsDoc.events.push({ type, time, text: "Key moment", duration: 2, position: "bottom" });
  }
  syncEditor();
}

function eventFromForm() {
  const type = value("event-type");
  const time = numericValue("event-time", 0);
  const label = value("event-label").trim();
  if (type === "zoom") {
    return {
      type,
      time,
      x: numericValue("event-x", 900),
      y: numericValue("event-y", 520),
      scale: numericValue("event-scale", 1.35),
      duration: numericValue("event-duration", 1.5),
      lead: 0.25,
      label: label || undefined,
    };
  }
  if (type === "click") {
    return {
      type,
      time,
      x: numericValue("event-x", 900),
      y: numericValue("event-y", 520),
      scale: numericValue("event-scale", 1.35),
      duration: numericValue("event-duration", 1.5),
      lead: 0.25,
      zoom: true,
      label: label || undefined,
    };
  }
  if (type === "speed") {
    const start = numericValue("event-start", time);
    return {
      type,
      time: start,
      start,
      end: numericValue("event-end", start + 2.5),
      factor: numericValue("event-factor", 2.5),
      label: label || "Speed through typing",
    };
  }
  if (type === "caption") {
    return {
      type,
      time,
      text: label || "Key moment",
      duration: numericValue("event-duration", 2),
      position: "bottom",
    };
  }
  return { type: "marker", time, label: label || "Marker" };
}

function addEventFromForm() {
  if (!eventsDoc) eventsDoc = { version: 1, recording: {}, events: [] };
  eventsDoc.events.push(eventFromForm());
  syncEditor();
}

function useVideoTime() {
  const time = $("preview-video").currentTime || 0;
  $("event-time").value = time.toFixed(1);
  $("event-start").value = time.toFixed(1);
  $("event-end").value = (time + 2.5).toFixed(1);
}

function renderPayload() {
  return {
    canvas: value("render-canvas"),
    crf: numericValue("render-crf", 18),
    preset: value("render-preset"),
    background: value("render-background") || "#f3f0ea",
  };
}

async function startRecording() {
  setStatus("Starting recording");
  const payload = {
    name: value("record-name"),
    display: value("record-display"),
    duration: value("record-duration"),
    audio: $("record-audio").checked,
    cursor: $("record-cursor").checked,
    show_clicks: $("record-clicks").checked,
  };
  await api("/api/record/start", { method: "POST", body: JSON.stringify(payload) });
  await refreshStatus();
  await refreshRuns();
  setStatus("Recording");
}

async function stopRecording() {
  setStatus("Stopping recording");
  const result = await api("/api/record/stop", {
    method: "POST",
    body: JSON.stringify({ render: true, output: "final.mp4", ...renderPayload() }),
  });
  selectedRun = result.session.run_dir.split("/").at(-1);
  await refreshStatus();
  await refreshRuns();
  setStatus("Stopped and rendered");
}

async function save() {
  if (!selectedRun) return;
  parseEditor();
  setStatus("Saving");
  await api(`/api/runs/${encodeURIComponent(selectedRun)}/events`, {
    method: "PUT",
    body: JSON.stringify(eventsDoc),
  });
  setStatus("Saved");
}

async function render() {
  if (!selectedRun) return;
  await save();
  setStatus("Rendering");
  $("render-status").textContent = "Rendering";
  const result = await api(`/api/runs/${encodeURIComponent(selectedRun)}/render`, {
    method: "POST",
    body: JSON.stringify(renderPayload()),
  });
  setStatus(`Rendered ${result.output}`);
  $("render-status").textContent = "Ready";
  await refreshRuns();
  renderVideoPanel();
}

bind("refresh", "click", () => refreshRuns().catch((error) => setStatus(error.message)));
bind("save", "click", () => save().catch((error) => setStatus(error.message)));
bind("render", "click", () => render().catch((error) => setStatus(error.message)));
bind("start-record", "click", () => startRecording().catch((error) => setStatus(error.message)));
bind("stop-record", "click", () => stopRecording().catch((error) => setStatus(error.message)));
bind("add-event", "click", () => addEventFromForm());
bind("use-video-time", "click", () => useVideoTime());
$("json-editor").addEventListener("blur", () => {
  try {
    parseEditor();
    setStatus("Idle");
  } catch (error) {
    setStatus(error.message);
  }
});

const videoEl = $("preview-video");
if (videoEl) {
  videoEl.addEventListener("timeupdate", updateStripCursor);
  videoEl.addEventListener("loadedmetadata", () => {
    const duration = timelineDuration();
    renderRuler(duration);
    renderTimelineStrip(duration);
    updateStripCursor();
  });
  videoEl.addEventListener("seeked", updateStripCursor);
}

// Click + drag on the timeline tracks area seeks the video preview.
// Bound to .strip-tracks (not .timeline-strip) so toolbar + lane headers
// remain clickable for their own purposes.
const tracksEl = $("strip-tracks");
if (tracksEl && videoEl) {
  let dragging = false;
  function seekFromPointer(clientX) {
    const rect = tracksEl.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const duration = timelineDuration();
    const cursor = $("strip-cursor");
    if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
      videoEl.currentTime = ratio * Math.min(duration, videoEl.duration);
    } else if (cursor) {
      cursor.hidden = false;
      cursor.style.left = `${ratio * 100}%`;
    }
  }
  tracksEl.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("chip")) return;
    dragging = true;
    const cursor = $("strip-cursor");
    cursor?.classList.add("scrubbing");
    tracksEl.setPointerCapture(e.pointerId);
    seekFromPointer(e.clientX);
  });
  tracksEl.addEventListener("pointermove", (e) => {
    if (dragging) seekFromPointer(e.clientX);
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    const cursor = $("strip-cursor");
    cursor?.classList.remove("scrubbing");
    try { tracksEl.releasePointerCapture(e.pointerId); } catch {}
  }
  tracksEl.addEventListener("pointerup", endDrag);
  tracksEl.addEventListener("pointercancel", endDrag);
  tracksEl.style.cursor = "ew-resize";
}

// Quick-add toolbar buttons.
document.querySelectorAll(".quick-add[data-add]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (!eventsDoc) eventsDoc = { version: 1, recording: {}, events: [] };
    const type = btn.dataset.add;
    const v = $("preview-video");
    const time = Math.round(((v?.currentTime || 0)) * 10) / 10;
    let event;
    if (type === "zoom")    event = { type, time, x: 900, y: 520, scale: 1.45, duration: 1.5, lead: 0.25 };
    else if (type === "click")   event = { type, time, x: 900, y: 520, scale: 1.35, duration: 1.4, lead: 0.25, zoom: true };
    else if (type === "caption") event = { type, time, text: "Caption", duration: 2, position: "bottom" };
    else if (type === "speed")   event = { type, time, start: time, end: Math.round((time + 2.5) * 10) / 10, factor: 2.5 };
    else if (type === "cut")     event = { type, time, start: time, end: Math.round((time + 1.5) * 10) / 10 };
    else                          event = { type: "marker", time, label: "Marker" };
    eventsDoc.events.push(event);
    syncEditor();
    // Auto-save so live polling doesn't wipe the addition seconds later.
    if (selectedRun) {
      try {
        await api(`/api/runs/${encodeURIComponent(selectedRun)}/events`, {
          method: "PUT",
          body: JSON.stringify(eventsDoc),
        });
        setStatus(`Added ${type}`);
      } catch (err) {
        setStatus(`Add failed: ${err.message}`);
      }
    }
  });
});


refreshStatus().catch((error) => setStatus(error.message));
refreshRuns().catch((error) => setStatus(error.message));

// Periodic status check so live polling auto-enables when a recording starts.
setInterval(() => {
  refreshStatus().catch(() => {});
}, 2000);

// Spacebar = play/pause the video preview (when not typing).
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || tag === "button") return;
  const v = $("preview-video");
  if (!v) return;
  e.preventDefault();
  v.paused ? v.play() : v.pause();
});

// Voice mode wiring (Electron-only via window.studio bridge).
if (window.studio) {
  const hero = $("voice-hero");
  const btn = $("voice-toggle");
  const label = btn.querySelector(".voice-button-label");
  const log = $("voice-log");
  const stats = $("agent-stats");
  hero.hidden = false;
  log.hidden = false;
  stats.hidden = false;

  function setVoiceUi(active) {
    voiceActive = active;
    btn.classList.toggle("active", active);
    if (label) label.textContent = active ? "Stop Voice Mode" : "Start Voice Mode";
  }

  async function refreshAgentStats() {
    try {
      const s = await window.studio.stats();
      stats.innerHTML = `
        <div class="agent-stat"><strong>${s.runs}</strong><span>runs</span></div>
        <div class="agent-stat"><strong>${s.utterances}</strong><span>heard</span></div>
        <div class="agent-stat"><strong>${s.tool_calls}</strong><span>marks</span></div>
      `;
    } catch (err) {
      stats.textContent = "";
    }
  }

  btn.addEventListener("click", async () => {
    const result = await window.studio.toggleVoice();
    setVoiceUi(result.active);
  });
  window.studio.onListenLog((line) => {
    for (const part of String(line).split("\n")) {
      const trimmed = part.trim();
      if (trimmed) appendVoiceLog(trimmed);
    }
    refreshAgentStats();
  });
  window.studio.onListenState((state) => setVoiceUi(!!state.active));
  window.studio.getVoiceState().then((state) => setVoiceUi(!!state.active));
  refreshAgentStats();
  setInterval(refreshAgentStats, 5000);
}
