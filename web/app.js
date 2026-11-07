"use strict";
const TOKEN = new URLSearchParams(location.search).get("t") || "";
let TITLE = "", VERSION = "", DUR = 1, FPS = 30, SCENES = [];
const CATS = ["Visual", "Text", "Timing", "Sound", "Other"];
const DECISIONS = [
  ["ok", "Approved", "#66eb82"],
  ["small", "Approved with minor changes", "#ffc261"],
  ["changes", "Changes required", "#ff7a70"],
];
const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 5v14l12-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z"/><path d="M15 8.5a5 5 0 0 1 0 7" fill="none" stroke-width="1.8" stroke-linecap="round"/></svg>',
  muted: '<svg viewBox="0 0 24 24"><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5" fill="none" stroke-width="1.8" stroke-linecap="round"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20l1-4L16 5l3 3L8 19z"/></svg>',
  x: '<svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (t) => { const s = Math.floor(t); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${String(Math.floor((t - s) * 100)).padStart(2, "0")}`; };
const sceneAt = (t) => SCENES.find((s) => t >= s.t0 && t < s.t1) || SCENES[SCENES.length - 1];
const native = (m) => window.ipc && window.ipc.postMessage(m);
const api = (p, body) => fetch("api/" + p, { method: body === undefined ? "GET" : "POST", headers: { "X-Review-Token": TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());

const video = $("#video");
let PROJECT_KEY = "";
let state = { notes: [], votes: {}, nextId: 1, name: "", decision: "", summary: "", version: "" };
let draft = null, saveTimer = 0, tab = "scenes", lastBeat = null, lastScene = "";

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api("state", state).catch(() => {}), 300);
}

/* ---- stage size: exact 16:9 box so pins stay on their spot */
function fit() {
  const w = $("#stageWrap").clientWidth, h = $("#stageWrap").clientHeight;
  const sw = Math.floor(Math.min(w, h * 16 / 9));
  const st = $("#stage");
  st.style.width = sw + "px";
  st.style.height = Math.floor(sw * 9 / 16) + "px";
  if (draft) placeComposer();
}
new ResizeObserver(fit).observe($("#stageWrap"));

/* ---- transport */
function setPlay(playing) {
  if (playing) {
    closeComposer();
    if (video.ended || video.currentTime >= DUR - 0.03) video.currentTime = 0;
    video.play().catch(() => {});
  } else video.pause();
}
const toggle = () => setPlay(video.paused);
function seek(t, pause = true) {
  if (pause) video.pause();
  video.currentTime = clamp(t, 0, DUR - 0.01);
}
function syncPlayUi() {
  const p = video.paused;
  $("#play").innerHTML = p ? ICONS.play : ICONS.pause;
  $("#play").setAttribute("aria-label", p ? "Play" : "Pause");
  $("#bigPlay").hidden = !(p && video.currentTime < 0.02 && !draft);
  renderOverlay();
}
function tick() {
  const t = video.currentTime;
  const pct = t / DUR * 100;
  $("#played").style.width = pct + "%";
  $("#head").style.left = pct + "%";
  $("#time").innerHTML = `<b>${fmt(t)}</b> / ${fmt(DUR)}`;
  const sc = sceneAt(t);
  if (sc.id !== lastScene) {
    lastScene = sc.id;
    document.querySelectorAll(".scene").forEach((n) => n.classList.toggle("now", n.dataset.id === sc.id));
  }
  requestAnimationFrame(tick);
}
["play", "pause", "seeked", "ended", "loadeddata"].forEach((e) => video.addEventListener(e, syncPlayUi));
video.addEventListener("timeupdate", () => { if (video.paused) renderOverlay(); });

function buildControls() {
  $("#play").innerHTML = ICONS.play;
  $("#play").onclick = toggle;
  $("#bigPlay").onclick = (e) => { e.stopPropagation(); setPlay(true); };
  $("#stepBack").onclick = () => seek(video.currentTime - 1 / FPS);
  $("#stepNext").onclick = () => seek(video.currentTime + 1 / FPS);
  $("#speeds").innerHTML = [0.25, 0.5, 1].map((s) => `<button data-s="${s}" class="${s === 1 ? "on" : ""}">${s}x</button>`).join("");
  $("#speeds").onclick = (e) => {
    const b = e.target.closest("button"); if (!b) return;
    video.playbackRate = +b.dataset.s;
    [...$("#speeds").children].forEach((c) => c.classList.toggle("on", c === b));
  };
  const vol = $("#vol"), mute = $("#mute");
  const syncVol = () => { mute.innerHTML = video.muted || video.volume === 0 ? ICONS.muted : ICONS.vol; };
  video.volume = 0.9;
  vol.oninput = () => { video.volume = +vol.value; video.muted = false; syncVol(); };
  mute.onclick = () => { video.muted = !video.muted; syncVol(); };
  syncVol();
  $("#fs").onclick = toggleFull;
  $("#addGeneral").onclick = () => openComposer({ x: null, y: null, target: "General", general: true });
}
function toggleFull() {
  const on = !document.body.classList.contains("full");
  document.body.classList.toggle("full", on);
  native(on ? "fs:on" : "fs:off");
}

/* ---- timeline */
function buildTimeline() {
  $("#segments").innerHTML = SCENES.map((s) => `<div class="sg" data-id="${s.id}" style="flex:${s.t1 - s.t0} 1 0"></div>`).join("");
  const tl = $("#timeline"), tip = $("#tip");
  const at = (e) => clamp((e.clientX - tl.getBoundingClientRect().left) / tl.clientWidth, 0, 1) * DUR;
  let drag = false;
  tl.onpointerdown = (e) => { drag = true; tl.setPointerCapture(e.pointerId); closeComposer(); seek(at(e)); };
  tl.onpointermove = (e) => {
    const t = at(e);
    tip.hidden = false;
    tip.textContent = `${sceneAt(t).name} · ${fmt(t)}`;
    tip.style.left = clamp(e.clientX - tl.getBoundingClientRect().left, 90, tl.clientWidth - 90) + "px";
    if (drag) seek(t);
  };
  tl.onpointerup = () => { drag = false; };
  tl.onpointerleave = () => { tip.hidden = true; };
}

/* ---- overlay on the frame */
function beatAt(t) {
  for (const s of SCENES) for (const b of s.beats) if (t >= b.t0 && t <= b.t1) return b;
  return null;
}
function renderOverlay() {
  const t = video.currentTime, paused = video.paused;
  const beat = paused && !draft ? beatAt(t) : null;
  if (beat !== lastBeat || !paused) {
    lastBeat = beat;
    const spots = beat ? beat.els.map((e, i) => {
      const [label, x0, y0, x1, y1] = e;
      const full = x1 - x0 > .98;
      const cls = (full ? "back inside" : y0 < .1 ? "below" : "");
      return `<button class="spot ${cls}" data-i="${i}" aria-label="${esc(label)}" style="left:${x0 * 100}%;top:${y0 * 100}%;width:${(x1 - x0) * 100}%;height:${(y1 - y0) * 100}%;z-index:${full ? 0 : 1}"><b>${esc(label)}</b></button>`;
    }).join("") : "";
    $("#spots").innerHTML = spots;
    $("#spots").onclick = (e) => {
      const b = e.target.closest(".spot"); if (!b) return;
      e.stopPropagation();
      const r = $("#stage").getBoundingClientRect();
      const label = beat.els[+b.dataset.i][0];
      const [, x0, y0, x1, y1] = beat.els[+b.dataset.i];
      openComposer({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, target: label, box: [x0, y0, x1, y1] });
    };
  }
  const near = paused ? state.notes.filter((n) => n.x !== null && Math.abs(n.t - t) < 0.05) : [];
  $("#pins").innerHTML = near.map((n) => `<button class="pin ${n.must ? "must" : ""}" data-id="${n.id}" style="left:${n.x * 100}%;top:${n.y * 100}%" aria-label="Note ${noteNo(n)}">${noteNo(n)}</button>`).join("")
    + (draft && !draft.general ? `<div class="pin draft" style="left:${draft.x * 100}%;top:${draft.y * 100}%">+</div>` : "");
  const hint = $("#hint");
  const showHint = paused && !draft && video.currentTime > 0.02;
  hint.classList.toggle("on", showHint);
  if (showHint) hint.textContent = beat ? "Click an element or anywhere in the frame" : "Click the frame to leave a note here";
}
const noteNo = (n) => [...state.notes].sort((a, b) => a.t - b.t || a.id - b.id).indexOf(n) + 1;

$("#stage").addEventListener("click", (e) => {
  if (e.target.closest("#composer,#bigPlay,.spot")) return;
  const pin = e.target.closest(".pin[data-id]");
  if (pin) { focusNote(+pin.dataset.id); return; }
  if (draft) { closeComposer(); return; }
  if (video.currentTime < 0.02 && video.paused) { setPlay(true); return; }
  const r = $("#stage").getBoundingClientRect();
  video.pause();
  openComposer({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, target: "" });
});

/* ---- composer */
function openComposer(d) {
  video.pause();
  draft = { cat: "", must: false, ...d, t: video.currentTime };
  const sc = sceneAt(draft.t);
  $("#cpTarget").textContent = d.general ? "General note" : (d.target || sc.name);
  $("#cpTime").textContent = d.general ? "" : fmt(draft.t);
  $("#cpText").value = "";
  $("#cpMust").checked = false;
  $("#cpCats").innerHTML = CATS.map((c) => `<button type="button" class="chip" data-c="${c}">${c}</button>`).join("");
  $("#composer").hidden = false;
  $("#stage").classList.add("composing");
  placeComposer();
  renderOverlay();
  syncPlayUi();
  $("#cpText").focus();
}
function placeComposer() {
  const st = $("#stage"), cp = $("#composer");
  const W = st.clientWidth, H = st.clientHeight, w = cp.offsetWidth, h = cp.offsetHeight;
  if (draft.general) { cp.style.left = (W - w) / 2 + "px"; cp.style.top = (H - h) / 2 + "px"; cp.style.transformOrigin = "center"; return; }
  const px = draft.x * W, py = draft.y * H;
  const b = draft.box && draft.box[2] - draft.box[0] < .9 ? draft.box : null;
  const r0 = (b ? b[2] * W : px) + 14, l0 = (b ? b[0] * W : px) - 14;
  const right = r0 + w <= W - 8 || l0 - w < 8;
  const left = right ? Math.min(r0, W - w - 8) : l0 - w;
  const top = clamp(py - 28, 8, Math.max(8, H - h - 8));
  cp.style.left = left + "px"; cp.style.top = top + "px";
  cp.style.transformOrigin = `${right ? "0" : "100%"} ${clamp(py - top, 0, h)}px`;
}
function closeComposer() {
  draft = null;
  $("#composer").hidden = true;
  $("#stage").classList.remove("composing");
  lastBeat = undefined;
  renderOverlay();
  syncPlayUi();
}
$("#cpCats").onclick = (e) => {
  const c = e.target.closest(".chip"); if (!c) return;
  const on = c.classList.contains("on");
  [...$("#cpCats").children].forEach((x) => x.classList.remove("on"));
  if (!on) c.classList.add("on");
  draft.cat = on ? "" : c.dataset.c;
};
$("#cpCancel").onclick = closeComposer;
function grabFrame() {
  try {
    const c = document.createElement("canvas");
    c.width = 640; c.height = 360;
    const g = c.getContext("2d");
    g.drawImage(video, 0, 0, 640, 360);
    return c.toDataURL("image/jpeg", 0.72);
  } catch (e) { return ""; }
}
$("#composer").onsubmit = (e) => {
  e.preventDefault();
  const text = $("#cpText").value.trim();
  if (!text) { $("#cpText").focus(); return; }
  const sc = sceneAt(draft.t);
  const n = {
    id: state.nextId++, t: draft.general ? 0 : draft.t, scene: draft.general ? "" : sc.id, sceneName: draft.general ? "General" : sc.name,
    x: draft.general ? null : draft.x, y: draft.general ? null : draft.y, target: draft.target, text, cat: draft.cat,
    must: $("#cpMust").checked, shot: draft.general ? "" : grabFrame(), general: !!draft.general,
  };
  state.notes.push(n);
  if (!n.general && state.votes[n.scene] === undefined) state.votes[n.scene] = "bad";
  closeComposer();
  renderAll();
  save();
};
$("#composer").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#composer").requestSubmit();
  e.stopPropagation();
});

/* ---- side panel */
function renderScenes() {
  const counts = {};
  state.notes.forEach((n) => { counts[n.scene + "/" + n.target] = 1; });
  $("#scenes").innerHTML = SCENES.map((s, i) => {
    const seen = new Set(), v = state.votes[s.id];
    const els = s.beats.flatMap((b) => b.els.map((e) => ({ label: e[0], x: (e[1] + e[3]) / 2, y: (e[2] + e[4]) / 2, peek: b.peek }))).filter((e) => !seen.has(e.label) && seen.add(e.label));
    return `<div class="scene" data-id="${s.id}">
      <div class="sc-top">
        <button class="sc-no" data-go="${i}" aria-label="Go to scene ${i + 1}">${i + 1}</button>
        <button class="sc-txt" data-go="${i}" style="padding:0;text-align:left"><strong>${esc(s.name)}</strong><small>${fmt(s.t0)} – ${fmt(s.t1)}</small></button>
        <div class="vote">
          <button class="ok ${v === "ok" ? "on" : ""}" data-v="ok" data-s="${s.id}" title="Looks good" aria-label="Looks good">${ICONS.up}</button>
          <button class="bad ${v === "bad" ? "on" : ""}" data-v="bad" data-s="${s.id}" title="Needs changes" aria-label="Needs changes">${ICONS.edit}</button>
        </div>
      </div>
      <div class="els">${els.map((e, j) => `<button class="el ${counts[s.id + "/" + e.label] ? "has" : ""}" data-s="${i}" data-e="${j}">${esc(e.label)}</button>`).join("")}</div>
    </div>`;
  }).join("");
  $("#scenes").querySelectorAll(".scene").forEach((n, i) => {
    const s = SCENES[i], seen = new Set();
    n._els = s.beats.flatMap((b) => b.els.map((e) => ({ label: e[0], x: (e[1] + e[3]) / 2, y: (e[2] + e[4]) / 2, peek: b.peek, box: e.slice(1) }))).filter((e) => !seen.has(e.label) && seen.add(e.label));
  });
  lastScene = "";
  document.querySelectorAll(".sg").forEach((g) => {
    const v = state.votes[g.dataset.id];
    g.classList.toggle("ok", v === "ok"); g.classList.toggle("bad", v === "bad");
  });
}
$("#scenes").onclick = (e) => {
  const v = e.target.closest("[data-v]");
  if (v) {
    state.votes[v.dataset.s] = state.votes[v.dataset.s] === v.dataset.v ? undefined : v.dataset.v;
    renderAll(); save(); return;
  }
  const g = e.target.closest("[data-go]");
  if (g) { closeComposer(); seek(SCENES[+g.dataset.go].t0, false); return; }
  const el = e.target.closest(".el");
  if (el) {
    const item = el.closest(".scene")._els[+el.dataset.e];
    closeComposer();
    const open = () => openComposer({ x: item.x, y: item.y, target: item.label, box: item.box });
    if (Math.abs(video.currentTime - item.peek) < 0.002) { video.pause(); open(); return; }
    seek(item.peek);
    video.addEventListener("seeked", open, { once: true });
  }
};
function renderNotes() {
  const sorted = [...state.notes].sort((a, b) => a.t - b.t || a.id - b.id);
  $("#noteCount").textContent = sorted.length;
  $("#notes").innerHTML = sorted.length ? sorted.map((n) => `
    <div class="note ${n.must ? "must" : ""} ${n.general ? "gen" : ""}" data-id="${n.id}">
      <div class="no">${noteNo(n)}</div>
      <div class="bd">
        <div class="mt"><span>${n.general ? "General" : fmt(n.t)}</span>${n.target && !n.general ? `<span>· ${esc(n.target)}</span>` : n.general ? "" : `<span>· ${esc(n.sceneName)}</span>`}${n.cat ? `<span>· ${esc(n.cat)}</span>` : ""}${n.must ? "<span>· Must fix</span>" : ""}</div>
        <p>${esc(n.text)}</p>
      </div>
      <button class="x" data-del="${n.id}" aria-label="Delete">${ICONS.x}</button>
    </div>`).join("") : `<div class="empty"><strong>No notes yet</strong>Click a spot or an element in the video.</div>`;
}
$("#notes").onclick = (e) => {
  const d = e.target.closest("[data-del]");
  if (d) {
    state.notes = state.notes.filter((n) => n.id !== +d.dataset.del);
    renderAll(); save(); return;
  }
  const n = e.target.closest(".note");
  if (n) focusNote(+n.dataset.id);
};
function focusNote(id) {
  const n = state.notes.find((x) => x.id === id); if (!n) return;
  if (!n.general) seek(n.t);
  setTab("notes");
  renderOverlay();
}
function setTab(t) {
  tab = t;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  $("#scenes").hidden = t !== "scenes"; $("#notes").hidden = t !== "notes";
}
document.querySelectorAll(".tabs button").forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
function renderMarks() {
  $("#marks").innerHTML = state.notes.filter((n) => !n.general).map((n) => `<i class="mk ${n.must ? "must" : ""}" style="left:${n.t / DUR * 100}%"></i>`).join("");
}
function renderProgress() {
  const voted = SCENES.filter((s) => state.votes[s.id]).length;
  $("#progress").textContent = `${voted} of ${SCENES.length} ${SCENES.length === 1 ? "scene" : "scenes"} reviewed`;
}
function renderAll() { renderScenes(); renderNotes(); renderMarks(); renderProgress(); lastBeat = undefined; renderOverlay(); }

/* ---- finish */
function openSend() {
  video.pause(); closeComposer();
  const ok = SCENES.filter((s) => state.votes[s.id] === "ok").length;
  const open = SCENES.length - SCENES.filter((s) => state.votes[s.id]).length;
  $("#modal").hidden = false;
  $("#sheet").innerHTML = `
    <h2>Finish feedback</h2>
    <p>${state.sentAt ? "You already sent feedback. Sending again adds your latest notes." : "Your feedback goes straight to the team."}</p>
    <div class="summary">
      <div><b>${ok}</b><small>scenes approved</small></div>
      <div><b>${state.notes.length}</b><small>notes</small></div>
      <div><b>${open}</b><small>not reviewed</small></div>
    </div>
    <div class="field"><span>What’s your decision?</span></div>
    <div class="opts" id="decs">${DECISIONS.map(([k, l, c]) => `<button class="opt ${state.decision === k ? "on" : ""}" data-k="${k}"><i style="background:${c}"></i>${l}</button>`).join("")}</div>
    <label class="field"><span>Your name</span><input id="fName" maxlength="60" value="${esc(state.name)}"></label>
    <label class="field"><span>Anything else? (optional)</span><textarea id="fSum" rows="3">${esc(state.summary)}</textarea></label>
    <div class="err" id="fErr" hidden></div>
    <div class="foot"><button class="btn ghost" id="fBack">Back</button><button class="btn primary" id="fDo">Send feedback</button></div>`;
  $("#decs").onclick = (e) => {
    const o = e.target.closest(".opt"); if (!o) return;
    state.decision = o.dataset.k;
    [...$("#decs").children].forEach((x) => x.classList.toggle("on", x === o));
    check();
  };
  const check = () => { $("#fDo").disabled = !(state.decision && $("#fName").value.trim()); };
  $("#fName").oninput = check;
  $("#fBack").onclick = () => { readForm(); save(); $("#modal").hidden = true; };
  $("#fDo").onclick = doSend;
  check();
}
function readForm() { state.name = $("#fName").value.trim(); state.summary = $("#fSum").value.trim(); }
function sendPayload() {
  const dec = DECISIONS.find((d) => d[0] === state.decision);
  const sorted = [...state.notes].sort((a, b) => a.t - b.t || a.id - b.id);
  return {
    name: state.name, title: TITLE, version: VERSION, summary: state.summary,
    decision: dec[1], color: parseInt(dec[2].slice(1), 16),
    approved: SCENES.filter((s) => state.votes[s.id] === "ok").length,
    changes: SCENES.filter((s) => state.votes[s.id] === "bad").length,
    open: SCENES.filter((s) => !state.votes[s.id]).length,
    noteCount: sorted.length, mustCount: sorted.filter((n) => n.must).length,
    notes: sorted.map((n, i) => ({
      where: `${i + 1}. ${n.general ? "General" : `${fmt(n.t)} ${n.target || n.sceneName}`}${n.must ? " (must fix)" : ""}`,
      text: n.text,
    })),
    html: reportHtml(),
  };
}
async function doSend() {
  readForm(); save();
  const btn = $("#fDo");
  btn.disabled = true;
  btn.textContent = "Sending…";
  const r = await api("send", sendPayload()).catch(() => ({ error: "network" }));
  if (r.ok) {
    state.sentAt = new Date().toISOString();
    save();
    $("#sheet").innerHTML = `
      <h2>Thanks, your feedback was sent</h2>
      <p>The team has it now. You can close the app or keep watching.</p>
      <div class="foot"><button class="btn primary" id="fClose">Done</button></div>`;
    $("#fClose").onclick = () => { $("#modal").hidden = true; };
    return;
  }
  const why = { too_large: "The feedback is too large to send.", rejected: "The server didn’t accept it.", not_configured: "Sending isn’t set up in this build." }[r.error] || "Please check your internet connection.";
  $("#sheet").innerHTML = `
    <h2>Couldn’t send your feedback</h2>
    <p>${why} Nothing is lost. You can try again or save it as a file and send that to us instead.</p>
    <div class="err" id="fErr" hidden></div>
    <div class="foot"><button class="btn ghost" id="fBack">Back</button><button class="btn ghost" id="fFile">Save as file</button><button class="btn primary" id="fRetry">Try again</button></div>`;
  $("#fBack").onclick = () => { $("#modal").hidden = true; };
  $("#fRetry").onclick = () => { $("#modal").hidden = true; openSend(); };
  $("#fFile").onclick = doExport;
}
async function doExport() {
  const r = await api("export", { name: state.name, html: reportHtml() }).catch(() => ({ error: "Saving failed" }));
  if (r.error) {
    const e = $("#fErr"); e.hidden = false; e.textContent = "The file could not be saved: " + r.error; return;
  }
  $("#sheet").innerHTML = `
    <h2>Your feedback file is ready</h2>
    <p>The file is on your desktop. Just send it back to us by email or chat.</p>
    <div class="path" id="fPath"></div>
    <div class="foot"><button class="btn ghost" id="fClose">Keep watching</button><button class="btn primary" id="fShow">Show in folder</button></div>`;
  $("#fPath").textContent = r.path;
  $("#fShow").onclick = () => api("reveal", { path: r.path });
  $("#fClose").onclick = () => { $("#modal").hidden = true; };
}
function reportHtml() {
  const dec = (DECISIONS.find((d) => d[0] === state.decision) || ["", "Open", "#999"]);
  const sorted = [...state.notes].sort((a, b) => a.t - b.t || a.id - b.id);
  const when = new Date().toLocaleString("en-GB");
  const votes = SCENES.map((s) => { const v = state.votes[s.id]; const l = v === "ok" ? "Approved" : v === "bad" ? "Changes" : "Open"; const c = v === "ok" ? "#18794e" : v === "bad" ? "#c33" : "#888"; return `<tr><td>${esc(s.name)}</td><td class="m">${fmt(s.t0)} – ${fmt(s.t1)}</td><td style="color:${c};font-weight:600">${l}</td></tr>`; }).join("");
  const items = sorted.map((n, i) => `<article>
    ${n.shot ? `<div class="shot"><img src="${n.shot}" alt=""><i style="left:${n.x * 100}%;top:${n.y * 100}%;background:${n.must ? "#ff7a70" : "#8fa8ff"}">${i + 1}</i></div>` : ""}
    <div><h3>${i + 1}. ${esc(n.general ? "General" : n.target || n.sceneName)}</h3>
    <div class="m">${n.general ? "not tied to a frame" : `${fmt(n.t)} · ${esc(n.sceneName)}`}${n.cat ? " · " + esc(n.cat) : ""}${n.must ? ' · <b style="color:#c33">Must fix</b>' : ""}</div>
    <p>${esc(n.text).replace(/\n/g, "<br>")}</p></div></article>`).join("");
  const data = JSON.stringify({ ...state, notes: state.notes.map(({ shot, ...n }) => n), exported: new Date().toISOString() }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(TITLE)} feedback ${esc(state.name)}</title><style>
body{font:15px/1.5 "Segoe UI",system-ui,sans-serif;color:#17171a;background:#f6f6f7;margin:0;padding:40px 16px}main{max-width:860px;margin:auto}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}h2{font-size:17px;margin:32px 0 10px}h3{font-size:15px;margin:0}p{margin:6px 0 0;white-space:pre-wrap}
.m{color:#71717a;font-size:13px;font-variant-numeric:tabular-nums}.badge{display:inline-flex;align-items:center;gap:8px;margin:14px 0 0;padding:6px 12px;border-radius:9px;background:#fff;box-shadow:0 0 0 1px #e4e4e7;font-weight:600}
.badge i{width:10px;height:10px;border-radius:50%}table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 0 0 1px #e4e4e7}td{padding:9px 12px;border-top:1px solid #eee}tr:first-child td{border:0}
article{display:flex;gap:16px;padding:14px;margin-bottom:10px;background:#fff;border-radius:12px;box-shadow:0 0 0 1px #e4e4e7}article>div:last-child{flex:1;min-width:0}
.shot{position:relative;width:280px;flex:none;border-radius:8px;overflow:hidden;line-height:0}.shot img{width:100%}.shot i{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;font:700 11px/22px "Segoe UI",sans-serif;text-align:center;color:#111;box-shadow:0 0 0 2px rgba(0,0,0,.3)}
@media(max-width:640px){article{display:block}.shot{width:100%;margin-bottom:10px}}</style></head><body><main>
<h1>${esc(TITLE)} feedback</h1><div class="m">${esc(state.name)} · ${esc(when)} ${VERSION ? ` · Version ${esc(VERSION)}` : ""}</div>
<div class="badge"><i style="background:${dec[2]}"></i>${esc(dec[1])}</div>
${state.summary ? `<h2>Summary</h2><p>${esc(state.summary)}</p>` : ""}
<h2>Scenes</h2><table>${votes}</table>
<h2>Notes (${sorted.length})</h2>${items || '<p class="m">No notes.</p>'}
</main><script type="application/json" id="feedback-data">${data}</` + `script></body></html>`;
}
$("#openSend").onclick = openSend;

/* ---- window + keyboard */
document.querySelectorAll("[data-win]").forEach((b) => { b.onclick = () => native(b.dataset.win); });
$("#bar").addEventListener("mousedown", (e) => { if (e.button === 0 && !e.target.closest("button")) native("drag"); });
$("#bar").addEventListener("dblclick", (e) => { if (!e.target.closest("button")) native("max"); });
document.querySelectorAll("#edges i").forEach((i) => { i.onmousedown = (e) => { e.preventDefault(); native("resize:" + i.dataset.r); }; });
document.addEventListener("keydown", (e) => {
  if (!$("#modal").hidden) { if (e.key === "Escape") { readForm(); save(); $("#modal").hidden = true; } return; }
  if (e.target.matches("textarea,input:not([type=range])")) return;
  if (e.key === " ") { e.preventDefault(); toggle(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); seek(video.currentTime - (e.shiftKey ? 1 : 1 / FPS)); }
  else if (e.key === "ArrowRight") { e.preventDefault(); seek(video.currentTime + (e.shiftKey ? 1 : 1 / FPS)); }
  else if (e.key.toLowerCase() === "f") toggleFull();
  else if (e.key === "Escape") { if (draft) closeComposer(); else if (document.body.classList.contains("full")) toggleFull(); }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && draft) closeComposer(); }, true);
document.addEventListener("contextmenu", (e) => { if (!e.target.closest("textarea,input,p")) e.preventDefault(); });

function showMissing(title, text) {
  $("#nvTitle").textContent = title;
  $("#nvText").textContent = text;
  $("#noVideo").hidden = false;
  $("#layout").hidden = true;
  $("#openSend").hidden = true;
}
(async function init() {
  const info = await api("project").catch(() => ({ found: false }));
  if (!info.found) {
    showMissing("No video found", "Unzip the whole folder first, then open ZFeedback.exe from there. The video has to stay next to the app.");
    return;
  }
  const ready = await new Promise((res) => {
    video.addEventListener("loadedmetadata", () => res(true), { once: true });
    video.addEventListener("error", () => res(false), { once: true });
    video.src = `media/video?t=${TOKEN}`;
  });
  if (!ready) {
    showMissing("This video can’t be played", "Please ask for an MP4 file with H.264 video.");
    return;
  }
  const p = info.project || {};
  TITLE = p.title || info.name;
  VERSION = p.version || "";
  DUR = video.duration;
  FPS = p.fps || 30;
  SCENES = p.scenes && p.scenes.length ? p.scenes : [{ id: "full", name: "Full video", t0: 0, t1: DUR, beats: [] }];
  PROJECT_KEY = `${TITLE}/${VERSION}/${Math.round(DUR)}`;
  state.project = PROJECT_KEY;
  state.version = VERSION;
  $("#projectName").textContent = VERSION ? `${TITLE} · ${VERSION}` : TITLE;
  buildControls();
  buildTimeline();
  try {
    const s = await api("state");
    if (s && s.notes && s.project === PROJECT_KEY) state = { ...state, ...s };
  } catch (e) { /* first run */ }
  renderAll();
  fit();
  syncPlayUi();
  tick();
})();
