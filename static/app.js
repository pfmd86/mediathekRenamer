"use strict";

const $ = (sel) => document.querySelector(sel);

const state = {
  folder: null,
  bundles: [], // { name, files, hasVideo, el, input }
};

const STORAGE_KEY = "mediathekRenamer.lastFolder";

// ---------- API ----------

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const browseApi = (path) => api(`/api/browse?path=${encodeURIComponent(path || "")}`);
const scanApi = (path) => api(`/api/scan?path=${encodeURIComponent(path)}`);
const renameApi = (oldName, newName) =>
  api("/api/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: state.folder, oldName, newName }),
  });

// ---------- Toast ----------

let toastTimer;
function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), isError ? 6000 : 3000);
}

// ---------- Step 1: folder ----------

async function openFolder(path) {
  try {
    const data = await scanApi(path);
    state.folder = data.path;
    $("#folder-input").value = data.path;
    try { localStorage.setItem(STORAGE_KEY, data.path); } catch {}
    renderBundles(data.bundles);
    $("#bundles-card").hidden = false;
  } catch (err) {
    toast(err.message, true);
  }
}

$("#folder-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const path = $("#folder-input").value.trim();
  if (path) openFolder(path);
});

// Folder picker dialog
let browseCurrent = null;

async function showBrowse(path) {
  try {
    const data = await browseApi(path);
    browseCurrent = data.path;
    $("#browse-path").textContent = data.path;
    const list = $("#browse-list");
    list.replaceChildren();
    const addItem = (label, target) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      btn.addEventListener("click", () => showBrowse(target));
      btn.addEventListener("dblclick", (e) => e.preventDefault());
      li.append(btn);
      list.append(li);
    };
    if (data.parent) addItem("⬑ ..", data.parent);
    for (const dir of data.dirs) addItem("📁 " + dir, data.path.replace(/\/$/, "") + "/" + dir);
    if (!data.dirs.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.style.padding = "7px 12px";
      li.textContent = "No subfolders";
      list.append(li);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

$("#browse-btn").addEventListener("click", async () => {
  await showBrowse($("#folder-input").value.trim() || state.folder || "");
  $("#browse-dialog").showModal();
});

$("#browse-dialog").addEventListener("close", () => {
  if ($("#browse-dialog").returnValue === "ok" && browseCurrent) openFolder(browseCurrent);
});

// ---------- Step 2: bundles ----------

// Season/episode markers in either order, e.g. "(E01_S05)", "S01E05", "s1.e5", "(S01/E05)".
const MARKER_RE = /(\(\s*)?(?<![A-Za-z0-9])([SE])(\d{1,3})[ ._\-\/]*([SE])(\d{1,3})(?!\d)(\s*\))?/gi;

// Normalizes one MARKER_RE match: separators removed, letters upper-cased, order and
// digits kept, parentheses kept when they enclose the marker. Null for "S01S02" etc.
function normalizeMarker(open, l1, d1, l2, d2, close) {
  if (l1.toUpperCase() === l2.toUpperCase()) return null;
  const core = l1.toUpperCase() + d1 + l2.toUpperCase() + d2;
  return open && close ? `(${core})` : core;
}

function findMarkers(name) {
  const found = [];
  for (const m of name.matchAll(MARKER_RE)) {
    const marker = normalizeMarker(...m.slice(1));
    if (marker && !found.includes(marker)) found.push(marker);
  }
  return found;
}

// Removes markers from a name (only those equal to `only`, if given) and tidies the
// separators left behind.
function stripMarkers(name, only = null) {
  return name
    .replace(MARKER_RE, (match, ...g) => {
      const marker = normalizeMarker(...g.slice(0, 6));
      return marker && (only === null || marker === only) ? " " : match;
    })
    .replace(/ {2,}/g, " ")
    .replace(/^[\s_.\-]+|[\s_.\-]+$/g, "");
}

// Season/episode markers always go first: "(E01S05) Title".
function putMarkerFirst(bundle, marker) {
  const rest = stripMarkers(bundle.input.value, marker);
  bundle.input.value = rest ? `${marker} ${rest}` : marker;
  bundle.input.focus();
  updateBundleState(bundle);
}

function validateName(name) {
  if (!name.trim()) return "Name must not be empty.";
  if (name !== name.trim()) return "Name must not start or end with whitespace.";
  if (name.startsWith(".")) return "Name must not start with a dot.";
  if (/[\/\\\0]/.test(name)) return "Name must not contain / or \\.";
  return null;
}

function renderBundles(bundles) {
  const list = $("#bundle-list");
  list.replaceChildren();
  const tpl = $("#bundle-template");

  state.bundles = bundles.map((b) => {
    const el = tpl.content.firstElementChild.cloneNode(true);
    const bundle = { ...b, el, input: el.querySelector(".bundle-input") };

    el.querySelector(".bundle-old").textContent = b.name;
    const files = el.querySelector(".files");
    for (const f of b.files) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = f.ext || "(no ext)";
      chip.title = f.name;
      files.append(chip);
    }

    const quick = el.querySelector(".quick");
    el.querySelector(".paste-btn").addEventListener("click", () => {
      const rest = stripMarkers(bundle.name).replace(/_/g, " ").replace(/ {2,}/g, " ").trim();
      bundle.input.value = [...findMarkers(bundle.name), rest].filter(Boolean).join(" ");
      bundle.input.focus();
      updateBundleState(bundle);
    });
    for (const marker of findMarkers(b.name)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quick-btn marker";
      btn.textContent = "+ " + marker;
      btn.title = `Put "${marker}" at the beginning of the new name`;
      btn.addEventListener("click", () => putMarkerFirst(bundle, marker));
      quick.insertBefore(btn, quick.querySelector(".paste-btn"));
    }

    bundle.input.value = b.name;
    bundle.input.addEventListener("input", () => updateBundleState(bundle));
    bundle.input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { bundle.input.value = bundle.name; updateBundleState(bundle); }
    });
    el.querySelector(".reset-btn").addEventListener("click", () => {
      bundle.input.value = bundle.name;
      updateBundleState(bundle);
      bundle.input.focus();
    });
    el.querySelector(".bundle-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      await saveBundle(bundle);
    });

    list.append(el);
    updateBundleState(bundle);
    return bundle;
  });

  applyFilter();
  updateSummary();
}

function isChanged(bundle) {
  return bundle.input.value !== bundle.name;
}

function updateBundleState(bundle) {
  const value = bundle.input.value;
  const changed = isChanged(bundle);
  const error = changed ? validateName(value) || duplicateError(bundle, value) : null;
  const preview = bundle.el.querySelector(".bundle-preview");

  bundle.el.classList.toggle("changed", changed);
  bundle.el.querySelector(".reset-btn").hidden = !changed;
  bundle.el.querySelector(".save-btn").disabled = !changed || !!error;
  preview.classList.toggle("error", !!error);
  preview.textContent = error
    ? error
    : changed
      ? "→ " + bundle.files.map((f) => value + f.ext).join("  ·  ")
      : "";
  bundle.error = error;
  updateSaveAll();
}

// Catch conflicts with other bundles in this folder before hitting the server.
function duplicateError(bundle, value) {
  const clash = state.bundles.find(
    (other) => other !== bundle && (isChanged(other) ? other.input.value : other.name) === value,
  );
  return clash ? `Another bundle is already named "${value}".` : null;
}

function updateSaveAll() {
  const pending = state.bundles.filter((b) => isChanged(b) && !b.error).length;
  const btn = $("#save-all-btn");
  btn.disabled = pending === 0;
  btn.textContent = pending > 0 ? `Save all changes (${pending})` : "Save all changes";
}

function updateSummary() {
  const total = state.bundles.length;
  const files = state.bundles.reduce((n, b) => n + b.files.length, 0);
  $("#bundle-summary").textContent = total
    ? `${total} bundle${total === 1 ? "" : "s"}, ${files} file${files === 1 ? "" : "s"} in ${state.folder}`
    : `No files found in ${state.folder}`;
}

function applyFilter() {
  const videoOnly = $("#video-only").checked;
  for (const b of state.bundles) b.el.hidden = videoOnly && !b.hasVideo;
}

async function saveBundle(bundle, { quiet = false } = {}) {
  if (!isChanged(bundle) || bundle.error) return false;
  const newName = bundle.input.value;
  try {
    await renameApi(bundle.name, newName);
    bundle.name = newName;
    bundle.files = bundle.files.map((f) => ({ ...f, name: newName + f.ext }));
    bundle.el.querySelector(".bundle-old").textContent = newName;
    bundle.el.querySelectorAll(".chip").forEach((chip, i) => (chip.title = bundle.files[i].name));
    for (const b of state.bundles) updateBundleState(b);
    if (!quiet) toast(`Renamed ${bundle.files.length} file${bundle.files.length === 1 ? "" : "s"} to "${newName}"`);
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

$("#save-all-btn").addEventListener("click", async () => {
  const pending = state.bundles.filter((b) => isChanged(b) && !b.error);
  let ok = 0;
  for (const b of pending) if (await saveBundle(b, { quiet: true })) ok++;
  if (ok === pending.length) toast(`Renamed ${ok} bundle${ok === 1 ? "" : "s"}`);
  else toast(`Renamed ${ok} of ${pending.length} bundles - see errors`, true);
});

$("#reload-btn").addEventListener("click", () => {
  if (state.bundles.some(isChanged) && !confirm("Discard unsaved changes and reload?")) return;
  openFolder(state.folder);
});

$("#video-only").addEventListener("change", applyFilter);

window.addEventListener("beforeunload", (e) => {
  if (state.bundles.some(isChanged)) e.preventDefault();
});

// ---------- Init ----------

try {
  const last = localStorage.getItem(STORAGE_KEY);
  if (last) $("#folder-input").value = last;
} catch {}
