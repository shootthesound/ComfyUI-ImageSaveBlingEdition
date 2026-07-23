// Image Save - Bling Edition — all-DOM node UI.
//
// The node shows no standard widgets. Everything lives in one DOM panel:
// a session gallery (viewer + scrub slider + filmstrip) fed by each
// execution and recovered from a server-side manifest keyed by a per-node
// UUID (so it survives page reloads AND ComfyUI restarts), plus a tabbed
// settings strip (Output / Naming / Metadata / Mask). All settings are
// serialized as one JSON blob in the hidden `config` widget, which the
// Python side parses.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_NAME = "ImageSaveBlingEdition";

// Mirrors DEFAULTS in bling_saver.py.
const DEFAULTS = {
    uuid: "",
    mode: "auto",
    format: "png",
    quality: 90,
    lossless_webp: false,
    png_compress: 4,
    filename: "%prefix%_%counter%",
    prefix: "ComfyUI",
    counter_pad: 5,
    use_subfolder: false,
    subfolder: "%date%",
    overwrite: false,
    meta_workflow: true,
    meta_prompt: true,
    meta_extra: [],
    sidecar_json: false,
    mask_enabled: false,
    mask_source: "input",
    mask_parts: ["face"],
    mask_confidence: 0.4,
    mask_refine: true,
    mask_invert: false,
    mask_suffix: "_mask",
    watermark_enabled: false,
    watermark_image: null,
    watermark_scale: 0.15,
    watermark_inset: 24,
    watermark_position: "br",
    watermark_opacity: 1.0,
};

const TOKENS = ["%counter%", "%date%", "%time%", "%seed%", "%model%",
                "%prefix%", "%width%", "%height%", "%index%"];

// Which config keys belong to which tab — used by presets (save/exclude by
// group) and kept in sync with DEFAULTS.
const GROUPS = {
    output: ["mode", "format", "quality", "lossless_webp", "png_compress"],
    naming: ["filename", "prefix", "counter_pad", "use_subfolder", "subfolder",
             "overwrite"],
    metadata: ["meta_workflow", "meta_prompt", "meta_extra", "sidecar_json"],
    mask: ["mask_enabled", "mask_source", "mask_parts", "mask_confidence",
           "mask_refine", "mask_invert", "mask_suffix"],
    watermark: ["watermark_enabled", "watermark_image", "watermark_scale",
                "watermark_inset", "watermark_position", "watermark_opacity"],
};
const GROUP_LABELS = { output: "Output", naming: "Naming", metadata: "Meta",
                       mask: "Mask", watermark: "W-mark" };

// ------------------------------------------------------------------ CSS

const CSS = `
.bling-root { display:flex; flex-direction:column; gap:5px; width:100%; height:100%;
  box-sizing:border-box; padding:6px; font-family:sans-serif; font-size:11px;
  color:#ccc; user-select:none; }
.bling-root * { box-sizing:border-box; }

.bling-viewer { position:relative; flex:1 1 auto; min-height:120px; background:#101014;
  border:1px solid #33333c; border-radius:6px; overflow:hidden;
  display:flex; align-items:center; justify-content:center; }
.bling-viewer img { max-width:100%; max-height:100%; object-fit:contain; }
.bling-empty { color:#666; font-size:12px; text-align:center; padding:12px; line-height:1.6; }
.bling-badge { position:absolute; top:6px; left:6px; background:rgba(0,0,0,0.65);
  color:#9cf; font-weight:bold; padding:2px 8px; border-radius:10px; font-size:10px; }
.bling-heldbadge { position:absolute; top:6px; right:6px; background:rgba(120,80,10,0.9);
  color:#ffd28a; font-weight:bold; padding:2px 8px; border-radius:10px; font-size:10px;
  border:1px solid rgba(220,180,110,0.9); }
.bling-nav { position:absolute; top:50%; transform:translateY(-50%); width:26px; height:48px;
  display:flex; align-items:center; justify-content:center; cursor:pointer;
  background:rgba(0,0,0,0.35); color:#ddd; font-size:16px; border-radius:5px;
  opacity:0; transition:opacity .15s; }
.bling-viewer:hover .bling-nav { opacity:1; }
.bling-nav:hover { background:rgba(0,0,0,0.7); color:#fff; }
.bling-nav.prev { left:5px; } .bling-nav.next { right:5px; }
.bling-namebar { position:absolute; left:0; right:0; bottom:0; display:flex; gap:6px;
  align-items:center; padding:4px 8px; background:rgba(10,10,14,0.75);
  font-size:10px; color:#aaa; }
.bling-namebar .bling-fname { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; }
.bling-ico { cursor:pointer; color:#9cf; padding:1px 6px; border-radius:3px;
  border:1px solid transparent; }
.bling-ico:hover { border-color:#557; background:rgba(60,80,140,0.3); }
.bling-ico.on { background:rgba(60,110,180,0.55); border-color:#79c; color:#fff; }
.bling-heldrow { position:absolute; left:0; right:0; bottom:22px; display:flex; gap:6px;
  justify-content:center; padding:4px; }
.bling-nameprompt { position:absolute; left:8px; right:8px; bottom:28px; z-index:5;
  display:flex; gap:6px; align-items:center; padding:7px 8px;
  background:rgba(14,14,20,0.96); border:1px solid #5b8dd6; border-radius:6px; }
.bling-nameprompt .bling-lab { flex:0 0 auto; color:#9cf; }
.bling-lb .bling-nameprompt { left:50%; right:auto; transform:translateX(-50%);
  width:min(480px, 90vw); bottom:44px; }

.bling-ctl { display:flex; align-items:center; gap:7px; }
.bling-ctl input[type=range] { flex:1 1 auto; accent-color:#5b8dd6; height:14px; }
.bling-count { font-size:10px; color:#9cf; min-width:44px; text-align:center;
  font-weight:bold; }

.bling-strip { display:flex; gap:4px; overflow-x:auto; overflow-y:hidden; flex:0 0 52px;
  padding:2px; background:#101014; border:1px solid #2a2a32; border-radius:5px;
  scrollbar-width:thin; }
.bling-strip:empty { display:none; }
.bling-thumb { position:relative; flex:0 0 auto; width:46px; height:46px; cursor:pointer;
  border:2px solid transparent; border-radius:4px; overflow:hidden; background:#000; }
.bling-thumb img { width:100%; height:100%; object-fit:cover; }
.bling-thumb.sel { border-color:#5b8dd6; }
.bling-thumb.held::after { content:""; position:absolute; inset:auto 2px 2px auto;
  width:7px; height:7px; border-radius:50%; background:#e8a33d;
  border:1px solid rgba(0,0,0,0.6); }

.bling-tabs { display:flex; gap:3px; }
.bling-tab { flex:1 1 0; text-align:center; padding:4px 2px; cursor:pointer;
  background:#1c1c22; border:1px solid #33333c; border-bottom:none;
  border-radius:5px 5px 0 0; color:#999; font-weight:bold; font-size:10px; }
.bling-tab:hover { color:#ccc; }
.bling-tab.on { background:#26262e; color:#9cf; border-color:#44445;
  border-color:#444450; }
.bling-panel { flex:0 0 158px; overflow-y:auto; background:#26262e;
  border:1px solid #444450; border-radius:0 0 5px 5px; padding:7px 8px;
  display:flex; flex-direction:column; gap:7px; scrollbar-width:thin; }

.bling-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.bling-lab { flex:0 0 58px; color:#888; font-size:10px; }
/* 58px is a row-label width; as a direct child of the column panel it would
   become a 58px height and open a blank gap under the text */
.bling-panel > .bling-lab { flex:0 0 auto; }
.bling-seg { display:flex; flex:1 1 auto; border:1px solid #4a4a56; border-radius:4px;
  overflow:hidden; }
.bling-seg > div { flex:1 1 0; text-align:center; padding:4px 2px; cursor:pointer;
  background:#1c1c22; color:#999; font-size:10px; font-weight:bold; }
.bling-seg > div:not(:last-child) { border-right:1px solid #4a4a56; }
.bling-seg > div.on { background:rgba(60,110,180,0.55); color:#fff; }
.bling-seg > div:hover:not(.on) { color:#ddd; }
.bling-pill { padding:3px 9px; border-radius:10px; cursor:pointer; font-size:10px;
  font-weight:bold; background:#1c1c22; border:1px solid #4a4a56; color:#999; }
.bling-pill:hover { color:#ddd; }
.bling-pill.on { background:rgba(60,110,180,0.55); border-color:#79c; color:#fff; }
.bling-pill.warn.on { background:rgba(160,90,30,0.55); border-color:#c97; }

.bling-in { background:#141418; color:#ddd; border:1px solid #4a4a56; border-radius:4px;
  padding:4px 7px; font-size:11px; min-width:0; }
.bling-in:focus { outline:none; border-color:#5b8dd6; }
.bling-in.grow { flex:1 1 auto; }
.bling-in.tiny { width:44px; text-align:center; }

.bling-chips { display:flex; gap:3px; flex-wrap:wrap; }
.bling-chip { padding:1px 6px; border-radius:3px; background:#1a2230; color:#8ab;
  border:1px solid #35455c; cursor:pointer; font-size:9px; font-family:monospace; }
.bling-chip:hover { background:#243349; color:#bde; }

.bling-example { font-size:9px; color:#6a8; font-family:monospace; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.bling-note { font-size:9px; color:#c97; line-height:1.4; }
.bling-dim { opacity:0.35; pointer-events:none; }

.bling-btn { cursor:pointer; padding:4px 10px; font-size:10px; font-weight:bold;
  border-radius:4px; border:1px solid #555; background:#2a2a2a; color:#ccc; }
.bling-btn:hover { filter:brightness(1.25); }
.bling-btn.save { background:rgba(40,72,56,0.95); border-color:rgba(110,210,160,0.9);
  color:#d2f3e2; }
.bling-btn.danger { background:rgba(70,45,45,0.95); border-color:rgba(220,120,110,0.9);
  color:#ffd8d0; }
.bling-btn.mini { padding:2px 7px; }
.bling-btn.on { background:rgba(110,85,20,0.6); border-color:#d4af37; color:#ffd24a; }

.bling-info { flex:0 0 auto; color:#7a9; font-size:9px; white-space:nowrap; }
.bling-tag { position:absolute; top:2px; left:2px; font-size:9px; font-weight:bold;
  color:#ffd24a; text-shadow:0 0 3px #000, 0 0 3px #000; z-index:1; }
.bling-tag.pin { top:auto; bottom:2px; left:2px; color:#8fd0ff; }
.bling-abbtn { position:absolute; right:6px; top:38px; padding:3px 10px; cursor:pointer;
  background:rgba(20,40,70,0.8); border:1px solid #5b8dd6; border-radius:10px;
  color:#bde; font-size:10px; font-weight:bold; user-select:none; }
.bling-abbtn:hover { background:rgba(40,70,120,0.9); }
.bling-abbadge { position:absolute; top:6px; left:50%; transform:translateX(-50%);
  background:rgba(20,40,70,0.85); color:#8fd0ff; font-weight:bold; font-size:11px;
  padding:2px 10px; border-radius:10px; border:1px solid #5b8dd6; }

.bling-lb { position:fixed; inset:0; z-index:10000; background:rgba(5,5,8,0.96);
  display:flex; align-items:center; justify-content:center; overflow:hidden;
  font-family:sans-serif; font-size:12px; color:#ccc; user-select:none; }
.bling-lb img { position:absolute; top:50%; left:50%; transform-origin:0 0;
  image-rendering:auto; cursor:grab; }
.bling-lb img.pixel { image-rendering:pixelated; }
.bling-lb-top { position:absolute; top:0; left:0; right:0; display:flex; gap:8px;
  align-items:center; padding:8px 12px; background:rgba(10,10,14,0.8); z-index:2; }
.bling-lb-top .bling-fname { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; color:#ddd; }
.bling-lb-bot { position:absolute; bottom:0; left:0; right:0; display:flex; gap:10px;
  align-items:center; padding:6px 12px; background:rgba(10,10,14,0.8); z-index:2;
  font-size:11px; color:#9cf; }
.bling-lb-hint { flex:1 1 auto; text-align:center; color:#556; font-size:10px; }

.bling-pos { display:grid; grid-template-columns:repeat(3, 15px);
  grid-auto-rows:15px; gap:2px; }
.bling-pos > div { background:#1c1c22; border:1px solid #4a4a56; border-radius:3px;
  cursor:pointer; }
.bling-pos > div:hover { border-color:#79c; }
.bling-pos > div.on { background:rgba(60,110,180,0.8); border-color:#9cf; }
.bling-wmprev { width:38px; height:38px; object-fit:contain; border-radius:4px;
  border:1px solid #4a4a56;
  background:repeating-conic-gradient(#2e2e36 0% 25%, #1a1a20 0% 50%) 0 0/12px 12px; }

.bling-fields { display:flex; flex-direction:column; gap:4px; }
.bling-frow { display:flex; gap:4px; }
.bling-frow input:first-child { flex:0 0 34%; }
.bling-frow input:nth-child(2) { flex:1 1 auto; }
.bling-x { cursor:pointer; color:#c88; padding:2px 6px; font-weight:bold; }
.bling-x:hover { color:#f99; }
select.bling-in { padding:3px 4px; }
`;

let cssInjected = false;
function injectCSS() {
    if (cssInjected) return;
    const st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);
    cssInjected = true;
}

// ------------------------------------------------------------------ helpers

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function genId() {
    try { return crypto.randomUUID().replace(/-/g, "").slice(0, 24); }
    catch (e) { return "bling" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); }
}

function viewUrl(ref, ts, thumb) {
    const p = new URLSearchParams({
        filename: ref.filename,
        subfolder: ref.subfolder || "",
        type: ref.type || "output",
        t: String(ts || ""),
    });
    if (thumb) p.set("preview", "webp;60");
    return api.apiURL("/view?" + p.toString());
}

function findWidget(node, name) {
    return node.widgets?.find((w) => w.name === name) || null;
}

// mediapipe availability + credit templates are global, fetched once/lazily
let CAPS = null;
async function fetchCaps() {
    if (CAPS) return CAPS;
    try {
        const r = await api.fetchApi("/imagesavebling/caps");
        CAPS = await r.json();
    } catch (e) { CAPS = { mediapipe: false }; }
    return CAPS;
}

let TEMPLATES = {};
let AUTO_TPL = "";
async function fetchTemplates() {
    try {
        const r = await api.fetchApi("/imagesavebling/templates");
        const data = await r.json();
        TEMPLATES = data.templates || {};
        AUTO_TPL = data.auto || "";
    } catch (e) { /* keep old */ }
    return TEMPLATES;
}

// Only called for brand-new nodes: the auto template's fields win over
// whatever the last-used config carried.
async function applyAutoTemplate(node) {
    await fetchTemplates();
    const bling = blingState(node);
    if (AUTO_TPL && TEMPLATES[AUTO_TPL]) {
        bling.state.meta_extra = JSON.parse(JSON.stringify(TEMPLATES[AUTO_TPL]));
        writeConfig(node);
    }
}

// Node presets + the rolling last-used config (both server-side, per user).
let PRESETS = {};
let LASTCFG = null;
async function fetchPresets() {
    try {
        const r = await api.fetchApi("/imagesavebling/presets");
        const data = await r.json();
        PRESETS = data.presets || {};
        LASTCFG = data.last || null;
    } catch (e) { /* keep old */ }
    return PRESETS;
}

// Every settings change rolls into the last-used config (debounced), so the
// next fresh node starts exactly where you left off.
let lastPushTimer = null;
function pushLastConfig(state) {
    clearTimeout(lastPushTimer);
    const cfg = { ...state };
    delete cfg.uuid;
    LASTCFG = cfg;
    lastPushTimer = setTimeout(() => {
        api.fetchApi("/imagesavebling/presets", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ last: cfg }),
        }).catch(() => {});
    }, 1000);
}

// uuid -> node.id, to give pasted/cloned nodes their own history
const UUID_REG = new Map();

// ------------------------------------------------------------------ state

function blingState(node) {
    if (!node._bling) {
        node._bling = {
            state: JSON.parse(JSON.stringify(DEFAULTS)),
            entries: [],
            sel: -1,
            showMask: false,
            tab: "output",
            els: {},
            clearArmed: false,
            starFilter: false,
        };
    }
    return node._bling;
}

function writeConfig(node) {
    const w = findWidget(node, "config");
    if (w) w.value = JSON.stringify(blingState(node).state);
    pushLastConfig(blingState(node).state);
    app.graph?.setDirtyCanvas(true, true);
}

function syncFromWidget(node) {
    const bling = blingState(node);
    const w = findWidget(node, "config");
    let loaded = {};
    try { loaded = JSON.parse(w?.value || "{}") || {}; } catch (e) { loaded = {}; }
    const st = JSON.parse(JSON.stringify(DEFAULTS));
    for (const k of Object.keys(DEFAULTS)) if (k in loaded) st[k] = loaded[k];
    bling.state = st;

    // Persistent identity: brand-new nodes mint a UUID; a paste/clone carrying
    // another live node's UUID mints a fresh one (fresh history).
    bling.isFresh = !st.uuid; // truly new node, not a load/paste (those carry a uuid)
    const holder = UUID_REG.get(st.uuid);
    const holderAlive = holder != null && holder !== node.id
        && app.graph?.getNodeById(holder);
    if (!st.uuid || holderAlive) {
        st.uuid = genId();
        bling.entries = [];
        bling.sel = -1;
    }
    UUID_REG.set(st.uuid, node.id);
    writeConfig(node);
}

function setState(node, patch, rebuildPanel = true) {
    Object.assign(blingState(node).state, patch);
    writeConfig(node);
    if (rebuildPanel) renderPanel(node);
    updateExample(node);
}

// ------------------------------------------------------------------ history

async function fetchHistory(node) {
    const bling = blingState(node);
    if (!bling.state.uuid) return;
    try {
        const r = await api.fetchApi(
            "/imagesavebling/history?uuid=" + encodeURIComponent(bling.state.uuid));
        const data = await r.json();
        if (Array.isArray(data.entries)) {
            // Skip the re-render when nothing changed (refetches also fire on
            // focus/status events, which are frequent and usually no-ops).
            const sig = JSON.stringify(data.entries);
            if (sig === bling.lastSig) return;
            bling.lastSig = sig;
            const selId = bling.entries[bling.sel]?.id;
            bling.entries = data.entries;
            const keep = selId ? bling.entries.findIndex((x) => x.id === selId) : -1;
            bling.sel = keep >= 0 ? keep : bling.entries.length - 1;
            renderGallery(node);
        }
    } catch (e) { /* server gone — keep local */ }
}

// The server manifest is the source of truth and other tabs/windows can
// change it (their runs, commits, discards). ComfyUI only sends `executed`
// events to the tab that queued, so idle tabs resync from broadcast queue
// status changes and on regaining focus.
let refetchTimer = null;
function refetchAll(delay) {
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(() => {
        if (document.hidden) return; // visibilitychange catches this tab up later
        for (const n of app.graph?._nodes || []) {
            if (n?.type === NODE_NAME && n._bling?.state?.uuid) fetchHistory(n);
        }
    }, delay);
}

function appendRecords(node, records) {
    const bling = blingState(node);
    const known = new Set(bling.entries.map((r) => r.id));
    for (const r of records) if (!known.has(r.id)) bling.entries.push(r);
    bling.sel = bling.entries.length - 1;
    bling.showMask = false;
    bling.lastSig = null; // local append — let the next manifest sync land
    renderGallery(node);
}

function mergeUpdated(node, updated) {
    const bling = blingState(node);
    for (const u of updated || []) {
        const i = bling.entries.findIndex((r) => r.id === u.id);
        if (i >= 0) bling.entries[i] = u;
    }
    renderGallery(node);
}

async function commitHeld(node, ids) {
    const bling = blingState(node);
    try {
        const r = await api.fetchApi("/imagesavebling/commit", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uuid: bling.state.uuid, ids: ids || [] }),
        });
        const data = await r.json();
        mergeUpdated(node, data.entries);
        if (data.errors?.length) {
            console.warn("[ImageSaveBling] commit errors", data.errors);
        }
    } catch (e) { console.warn("[ImageSaveBling] commit failed", e); }
    fetchHistory(node); // resync — another tab may have acted on these too
}

async function discardHeld(node, rec) {
    const bling = blingState(node);
    try {
        await api.fetchApi("/imagesavebling/discard", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uuid: bling.state.uuid, id: rec.id }),
        });
    } catch (e) { /* still drop locally */ }
    const i = bling.entries.findIndex((r) => r.id === rec.id);
    if (i >= 0) bling.entries.splice(i, 1);
    bling.sel = Math.min(bling.sel, bling.entries.length - 1);
    renderGallery(node);
    fetchHistory(node);
}

async function clearHistory(node) {
    const bling = blingState(node);
    try {
        await api.fetchApi("/imagesavebling/clear", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uuid: bling.state.uuid }),
        });
    } catch (e) { /* ignore */ }
    bling.entries = [];
    bling.sel = -1;
    bling.lastSig = null;
    renderGallery(node);
    fetchHistory(node);
}

async function setStar(node, rec, starred) {
    rec.starred = starred;
    renderGallery(node);
    try {
        await api.fetchApi("/imagesavebling/star", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ uuid: blingState(node).state.uuid,
                                   id: rec.id, starred }),
        });
    } catch (e) { /* stays local until next sync */ }
}

async function discardMany(node, ids, allHeld = false) {
    const bling = blingState(node);
    try {
        await api.fetchApi("/imagesavebling/discard", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(allHeld
                ? { uuid: bling.state.uuid, all_held: true }
                : { uuid: bling.state.uuid, ids }),
        });
    } catch (e) { /* fall through to resync */ }
    bling.lastSig = null;
    await fetchHistory(node);
}

// The triage flow: commit every starred held image, discard the held rest.
async function keepStarred(node) {
    const bling = blingState(node);
    const held = bling.entries.filter((r) => r.held);
    const keep = held.filter((r) => r.starred).map((r) => r.id);
    const drop = held.filter((r) => !r.starred).map((r) => r.id);
    if (keep.length) await commitHeld(node, keep);
    if (drop.length) await discardMany(node, drop);
}

async function restoreWorkflow(node) {
    const bling = blingState(node);
    const rec = bling.entries[bling.sel];
    if (!rec) return;
    try {
        const r = await api.fetchApi("/imagesavebling/workflow?uuid="
            + encodeURIComponent(bling.state.uuid) + "&id=" + encodeURIComponent(rec.id));
        const wf = (await r.json()).workflow;
        if (wf) {
            await app.loadGraphData(wf);
        } else if (bling.els.fname) {
            bling.els.fname.textContent = "no workflow stored in this file";
            setTimeout(() => renderGallery(node), 1800);
        }
    } catch (e) { console.warn("[ImageSaveBling] workflow restore failed", e); }
}

// "Save to ComfyUI inputs": copy the selected image into the input folder
// under a name the user types in an inline prompt (Enter saves, Esc cancels).
function promptToInput(node, container) {
    const bling = blingState(node);
    const rec = bling.entries[bling.sel];
    if (!rec) return;
    container.querySelector(".bling-nameprompt")?.remove();

    const box = el("div", "bling-nameprompt");
    box.appendChild(el("div", "bling-lab", "→ input/"));
    const nameIn = el("input", "bling-in grow");
    nameIn.type = "text";
    nameIn.value = rec.filename.replace(/\.[^.]+$/, "");
    nameIn.addEventListener("pointerdown", (e) => e.stopPropagation());
    const okBtn = el("div", "bling-btn save mini", "Save");
    const cancelBtn = el("div", "bling-btn mini", "Cancel");
    const closeBox = () => box.remove();
    const confirm = async () => {
        const name = nameIn.value.trim();
        if (!name) return;
        closeBox();
        try {
            const r = await api.fetchApi("/imagesavebling/to_input", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ uuid: bling.state.uuid, id: rec.id, name }),
            });
            const data = await r.json();
            const msg = data.ok ? `saved to input/${data.filename}`
                                : "save to inputs failed";
            if (data.ok) {
                // Same refresh the R key runs, so Load Image combos pick up
                // the new file without a manual refresh.
                try { await app.refreshComboInNodes(); } catch (e) { /* ignore */ }
            }
            if (bling.els.fname) {
                bling.els.fname.textContent = msg;
                setTimeout(() => renderGallery(node), 2200);
            }
            if (bling.lbEls && bling.lb?.open) {
                bling.lbEls.fname.textContent = msg;
                setTimeout(() => renderLightbox(node), 2200);
            }
        } catch (e) { console.warn("[ImageSaveBling] save to inputs failed", e); }
    };
    okBtn.addEventListener("click", confirm);
    cancelBtn.addEventListener("click", closeBox);
    nameIn.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); confirm(); }
        if (e.key === "Escape") { e.preventDefault(); closeBox(); }
    });
    box.appendChild(nameIn);
    box.appendChild(okBtn);
    box.appendChild(cancelBtn);
    container.appendChild(box);
    nameIn.focus();
    nameIn.select();
}

// Two-click confirm for destructive buttons: first click arms, second fires.
function armable(btn, armLabel, action) {
    btn.addEventListener("click", () => {
        if (!btn._armed) {
            btn._armed = true;
            btn._idle = btn.textContent;
            btn.textContent = armLabel;
            btn.classList.add("danger");
            btn._disarm = setTimeout(() => {
                btn._armed = false;
                btn.textContent = btn._idle;
                btn.classList.remove("danger");
            }, 2500);
            return;
        }
        clearTimeout(btn._disarm);
        btn._armed = false;
        btn.textContent = btn._idle;
        btn.classList.remove("danger");
        action();
    });
}

// ------------------------------------------------------------------ example line

function expandExample(pattern, st) {
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    const dateFmt = (fmt) => fmt
        .replace(/yyyy/g, now.getFullYear())
        .replace(/yy/g, String(now.getFullYear()).slice(-2))
        .replace(/MM/g, p2(now.getMonth() + 1))
        .replace(/dd/g, p2(now.getDate()))
        .replace(/HH/g, p2(now.getHours()))
        .replace(/mm/g, p2(now.getMinutes()))
        .replace(/ss/g, p2(now.getSeconds()));
    return (pattern || "")
        .replace(/%date(?::([^%]+))?%/g, (_, f) => dateFmt(f || "yyyy-MM-dd"))
        .replace(/%time%/g, dateFmt("HH-mm-ss"))
        .replace(/%counter%/g, "1".padStart(Math.max(1, st.counter_pad | 0), "0"))
        .replace(/%prefix%/g, st.prefix || "")
        .replace(/%seed%/g, "123456789")
        .replace(/%model%/g, "flux-dev")
        .replace(/%width%/g, "1024")
        .replace(/%height%/g, "1024")
        .replace(/%index%/g, "0")
        .replace(/%format%/g, st.format);
}

function updateExample(node) {
    const bling = blingState(node);
    const ex = bling.els.example;
    if (!ex) return;
    const st = bling.state;
    const ext = { png: ".png", jpg: ".jpg", webp: ".webp" }[st.format] || ".png";
    const sub = st.use_subfolder
        ? expandExample((st.subfolder || "").replace(/%counter%/g, ""), st) + "/"
        : "";
    ex.textContent = "→ output/" + sub + expandExample(st.filename, st) + ext;
}

// ------------------------------------------------------------------ control builders

function seg(options, value, onPick) {
    const box = el("div", "bling-seg");
    for (const [val, label] of options) {
        const b = el("div", val === value ? "on" : "", label);
        b.addEventListener("click", () => onPick(val));
        box.appendChild(b);
    }
    return box;
}

function pill(label, on, onToggle, extraCls) {
    const p = el("div", "bling-pill" + (on ? " on" : "") + (extraCls ? " " + extraCls : ""), label);
    p.addEventListener("click", () => onToggle(!on));
    return p;
}

function textInput(value, placeholder, onChange, cls) {
    const i = el("input", "bling-in" + (cls ? " " + cls : ""));
    i.type = "text";
    i.value = value ?? "";
    if (placeholder) i.placeholder = placeholder;
    i.addEventListener("change", () => onChange(i.value));
    i.addEventListener("pointerdown", (e) => e.stopPropagation());
    return i;
}

function row(labelText, ...children) {
    const r = el("div", "bling-row");
    if (labelText != null) r.appendChild(el("div", "bling-lab", labelText));
    for (const c of children) r.appendChild(c);
    return r;
}

// ------------------------------------------------------------------ gallery rendering

// Entry indexes the gallery currently browses: all of them, or only the
// starred ones while the ★ filter is on. `sel` always indexes bling.entries.
function visibleIdx(bling) {
    const idx = [];
    bling.entries.forEach((r, i) => {
        if (!bling.starFilter || r.starred) idx.push(i);
    });
    return idx;
}

function renderGallery(node) {
    const bling = blingState(node);
    const E = bling.els;
    if (!E.viewer) return;
    const n = bling.entries.length;
    if (bling.sel >= n) bling.sel = n - 1;
    if (bling.sel < 0 && n > 0) bling.sel = n - 1;
    const vis = visibleIdx(bling);
    if (vis.length && !vis.includes(bling.sel)) {
        // selection was filtered out (or just unstarred) — snap to the
        // nearest visible entry before it, else the first visible
        const before = vis.filter((i) => i < bling.sel);
        bling.sel = before.length ? before[before.length - 1] : vis[0];
    }
    const rec = vis.length ? bling.entries[bling.sel] : null;
    const pos = vis.indexOf(bling.sel);

    // A/B compare: while abShow is held, the pinned entry replaces the view
    const pinRec = bling.pinId ? bling.entries.find((r) => r.id === bling.pinId) : null;
    if (!pinRec) bling.pinId = null;
    const comparing = pinRec && rec && pinRec.id !== rec.id;
    const showRec = (bling.abShow && comparing) ? pinRec : rec;

    // viewer
    E.mainImg.style.display = showRec ? "" : "none";
    E.empty.style.display = rec ? "none" : "";
    E.empty.innerHTML = (n && bling.starFilter)
        ? "No starred images.<br><span style='color:#555'>Star some (☆) or "
          + "click ★ to show everything again.</span>"
        : "Nothing saved yet this session.<br><span style='color:#555'>"
          + "Every image that passes through appears here.</span>";
    E.badge.style.display = rec ? "" : "none";
    E.heldBadge.style.display = rec?.held ? "" : "none";
    E.heldRow.style.display = rec?.held ? "" : "none";
    E.nameBar.style.display = rec ? "" : "none";
    E.navPrev.style.display = vis.length > 1 ? "" : "none";
    E.navNext.style.display = vis.length > 1 ? "" : "none";
    E.abBtn.style.display = comparing ? "" : "none";
    E.abBadge.style.display = comparing && bling.abShow ? "" : "none";
    E.abBadge.textContent = "A (pinned)";
    if (rec) {
        const showMask = bling.showMask && showRec.mask && !bling.abShow;
        E.mainImg.src = showMask
            ? viewUrl(showRec.mask, showRec.ts) : viewUrl(showRec, showRec.ts);
        E.badge.textContent = `${pos + 1} / ${vis.length}`
            + (bling.starFilter ? " ★" : "");
        E.fname.textContent = (rec.subfolder ? rec.subfolder + "/" : "") + rec.filename
            + (showMask ? "  (mask)" : "");
        E.info.textContent = [
            rec.seed != null ? `seed ${rec.seed}` : "",
            rec.model || "",
        ].filter(Boolean).join(" · ");
        E.starBtn.textContent = rec.starred ? "★" : "☆";
        E.starBtn.classList.toggle("on", !!rec.starred);
        E.pinBtn.classList.toggle("on", pinRec?.id === rec.id);
        E.wfBtn.style.display = rec.wf ? "" : "none";
        E.maskBtn.style.display = rec.mask ? "" : "none";
        E.maskBtn.classList.toggle("on", !!showMask);
    }

    // slider + count + star filter
    E.slider.max = String(Math.max(0, vis.length - 1));
    E.slider.value = String(Math.max(0, pos));
    E.slider.disabled = vis.length < 2;
    E.count.textContent = vis.length ? `${pos + 1}/${vis.length}` : "0/0";
    const starredAll = bling.entries.filter((r) => r.starred).length;
    E.filterBtn.style.display = (starredAll || bling.starFilter) ? "" : "none";
    E.filterBtn.classList.toggle("on", !!bling.starFilter);
    E.filterBtn.title = bling.starFilter
        ? "Showing starred only — click to show everything"
        : `Show only starred images (${starredAll})`;

    // bulk triage row
    const held = bling.entries.filter((r) => r.held);
    const starredHeld = held.filter((r) => r.starred).length;
    E.bulk.style.display = held.length ? "" : "none";
    if (!E.saveAll._armed) E.saveAll.textContent = `💾 Save all (${held.length})`;
    if (!E.keepStar._armed) {
        E.keepStar.textContent =
            `★ Keep starred held images (${starredHeld}/${held.length})`;
    }
    E.keepStar.style.display = starredHeld ? "" : "none";
    if (!E.discardAll._armed) E.discardAll.textContent = "✕ Discard all";

    // clear button
    E.clear.style.display = n ? "" : "none";
    if (!bling.clearArmed) { E.clear.textContent = "🗑"; E.clear.classList.remove("danger"); }

    // filmstrip (only the visible subset while the ★ filter is on)
    E.strip.innerHTML = "";
    for (const i of vis) {
        const r = bling.entries[i];
        const t = el("div", "bling-thumb" + (i === bling.sel ? " sel" : "") + (r.held ? " held" : ""));
        const img = el("img");
        img.loading = "lazy";
        img.src = viewUrl(r, r.ts, true);
        t.appendChild(img);
        if (r.starred) t.appendChild(el("div", "bling-tag", "★"));
        if (pinRec?.id === r.id) t.appendChild(el("div", "bling-tag pin", "A"));
        t.title = r.filename
            + (r.seed != null ? `\nseed ${r.seed}` : "")
            + (r.model ? `\n${r.model}` : "")
            + (r.held ? "\n(held — not saved yet)" : "");
        t.addEventListener("click", () => { bling.sel = i; bling.showMask = false; renderGallery(node); });
        E.strip.appendChild(t);
    }
    if (pos >= 0) {
        const selEl = E.strip.children[pos];
        selEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }

    if (bling.lb?.open) renderLightbox(node);
}

// ------------------------------------------------------------------ settings panel

function renderPanel(node) {
    const bling = blingState(node);
    const E = bling.els;
    if (!E.panel) return;
    const st = bling.state;
    E.panel.innerHTML = "";
    for (const [key, tabEl] of Object.entries(E.tabs)) {
        tabEl.classList.toggle("on", key === bling.tab);
    }
    const set = (patch, rebuild = true) => setState(node, patch, rebuild);

    if (bling.tab === "output") {
        E.panel.appendChild(row("Mode", seg(
            [["auto", "Auto-save"], ["hold", "Hold for review"]],
            st.mode, (v) => set({ mode: v }))));
        if (st.mode === "hold") {
            E.panel.appendChild(el("div", "bling-note",
                "Held images park in temp storage — browse the gallery and click "
                + "Save on the keepers. Unsaved holds are lost if ComfyUI restarts."));
        }
        E.panel.appendChild(row("Format", seg(
            [["png", "PNG"], ["jpg", "JPEG"], ["webp", "WebP"]],
            st.format, (v) => set({ format: v }))));
        if (st.format !== "png") {
            const q = el("input"); q.type = "range"; q.min = "1"; q.max = "100";
            q.value = String(st.quality);
            const qv = el("div", "bling-count", String(st.quality));
            q.addEventListener("input", () => { qv.textContent = q.value; });
            q.addEventListener("change", () => set({ quality: parseInt(q.value, 10) }, false));
            q.addEventListener("pointerdown", (e) => e.stopPropagation());
            const r = row("Quality", q, qv);
            if (st.format === "webp") {
                r.appendChild(pill("Lossless", st.lossless_webp,
                    (v) => set({ lossless_webp: v })));
            }
            if (st.format === "webp" && st.lossless_webp) q.classList.add("bling-dim");
            E.panel.appendChild(r);
        }
    }

    if (bling.tab === "naming") {
        const fnameIn = textInput(st.filename, "%prefix%_%counter%",
            (v) => set({ filename: v }, false), "grow");
        E.panel.appendChild(row("Filename", fnameIn));

        // Token chips insert into whichever pattern box (filename/subfolder)
        // last had focus, at its caret — falling back to the filename box.
        const trackFocus = (inputEl, key) => {
            inputEl.addEventListener("focus", () => {
                bling.patTarget = { el: inputEl, key };
            });
        };
        trackFocus(fnameIn, "filename");
        const insertToken = (tok) => {
            let t = bling.patTarget;
            if (!t?.el?.isConnected) t = { el: fnameIn, key: "filename" };
            const inp = t.el;
            const start = inp.selectionStart ?? inp.value.length;
            const end = inp.selectionEnd ?? start;
            inp.value = inp.value.slice(0, start) + tok + inp.value.slice(end);
            set({ [t.key]: inp.value }, false);
            const pos = start + tok.length;
            inp.focus();
            try { inp.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
        };
        const chips = el("div", "bling-chips");
        for (const tok of TOKENS) {
            const c = el("div", "bling-chip", tok);
            c.title = "Insert into the filename or subfolder box (whichever "
                + "was focused last)";
            // pointerdown would steal focus before we read the caret — block it
            c.addEventListener("pointerdown", (e) => e.preventDefault());
            c.addEventListener("click", () => insertToken(tok));
            chips.appendChild(c);
        }
        E.panel.appendChild(row(null, chips));
        const pad = textInput(String(st.counter_pad), "", (v) => {
            const n = Math.min(8, Math.max(1, parseInt(v, 10) || 5));
            set({ counter_pad: n });
        }, "tiny");
        pad.title = "Counter digits: how many digits %counter% is zero-padded to "
            + "(5 → 00001, 3 → 001)";
        const padLab = el("div", "bling-lab", "Counter digits");
        padLab.style.flex = "0 0 auto";
        padLab.title = pad.title;
        const ow = pill("Overwrite", st.overwrite, (v) => set({ overwrite: v }), "warn");
        ow.title = "Replace an existing file with the same name instead of "
            + "adding a number (for patterns without %counter%)";
        const prefixIn = textInput(st.prefix, "ComfyUI",
            (v) => set({ prefix: v }, false));
        prefixIn.style.width = "20ch";
        const sep = el("div", "", "|");
        sep.style.cssText = "color:#4a4a56; padding:0 3px; font-size:13px;";
        E.panel.appendChild(row("Prefix", prefixIn, padLab, pad, sep, ow));
        const subIn = textInput(st.subfolder, "%date%",
            (v) => set({ subfolder: v }, false), "grow");
        trackFocus(subIn, "subfolder");
        if (!st.use_subfolder) subIn.classList.add("bling-dim");
        E.panel.appendChild(row("Subfolder",
            pill(st.use_subfolder ? "On" : "Off", st.use_subfolder,
                (v) => set({ use_subfolder: v })),
            subIn));
        if (st.overwrite) {
            E.panel.appendChild(el("div", "bling-note",
                "Overwrite replaces an existing file of the same name "
                + "(patterns without %counter%). Earlier gallery entries sharing "
                + "the name will show the newest pixels."));
        }
        E.els.example = el("div", "bling-example");
        E.panel.appendChild(E.els.example);
        updateExample(node);
    }

    if (bling.tab === "metadata") {
        E.panel.appendChild(row(null,
            pill("Embed workflow", st.meta_workflow, (v) => set({ meta_workflow: v })),
            pill("Embed prompt", st.meta_prompt, (v) => set({ meta_prompt: v })),
            pill("Sidecar .json", st.sidecar_json, (v) => set({ sidecar_json: v }))));
        if (!st.meta_workflow && !st.sidecar_json) {
            E.panel.appendChild(el("div", "bling-note",
                "No workflow embedded or sidecar — these files won't restore a "
                + "workflow when dragged into ComfyUI."));
        }
        E.panel.appendChild(el("div", "bling-lab", "Custom fields (credits etc.)"));
        const fields = el("div", "bling-fields");
        (st.meta_extra || []).forEach((f, i) => {
            const r = el("div", "bling-frow");
            r.appendChild(textInput(f.key, "Key (e.g. Author)", (v) => {
                st.meta_extra[i].key = v; writeConfig(node);
            }));
            r.appendChild(textInput(f.value, "Value", (v) => {
                st.meta_extra[i].value = v; writeConfig(node);
            }));
            const x = el("div", "bling-x", "×");
            x.addEventListener("click", () => {
                st.meta_extra.splice(i, 1); writeConfig(node); renderPanel(node);
            });
            r.appendChild(x);
            fields.appendChild(r);
        });
        E.panel.appendChild(fields);
        const add = el("div", "bling-btn mini", "+ add field");
        add.addEventListener("click", () => {
            st.meta_extra = st.meta_extra || [];
            st.meta_extra.push({ key: "", value: "" });
            writeConfig(node); renderPanel(node);
        });

        // Credit templates: load / save-as / delete / auto-load, stored
        // server-side so they follow the user across workflows.
        const tplSel = el("select", "bling-in");
        tplSel.appendChild(el("option", "", "— template —"));
        for (const name of Object.keys(TEMPLATES)) {
            const o = el("option", "", name === AUTO_TPL ? "★ " + name : name);
            o.value = name;
            tplSel.appendChild(o);
        }
        if (bling.tplChoice && TEMPLATES[bling.tplChoice]) tplSel.value = bling.tplChoice;
        tplSel.addEventListener("change", () => {
            bling.tplChoice = tplSel.value;
            const t = TEMPLATES[tplSel.value];
            if (t) {
                st.meta_extra = JSON.parse(JSON.stringify(t));
                writeConfig(node); renderPanel(node);
            }
        });
        const tplAuto = pill("★ Auto", !!AUTO_TPL && bling.tplChoice === AUTO_TPL,
            async () => {
                const name = tplSel.value;
                if (!name) return;
                const next = AUTO_TPL === name ? "" : name;
                try {
                    const r = await api.fetchApi("/imagesavebling/templates", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ auto: next }),
                    });
                    const data = await r.json();
                    TEMPLATES = data.templates || TEMPLATES;
                    AUTO_TPL = data.auto ?? AUTO_TPL;
                    renderPanel(node);
                } catch (e) { /* ignore */ }
            });
        tplAuto.title = "Auto-load the selected template's fields onto every "
            + "newly added Image Save - Bling Edition node";
        const tplName = textInput("", "template name", () => {}, "grow");
        const tplSave = el("div", "bling-btn mini save", "Save");
        tplSave.title = "Save the current custom fields as a named template";
        tplSave.addEventListener("click", async () => {
            const name = tplName.value.trim();
            if (!name) return;
            try {
                const r = await api.fetchApi("/imagesavebling/templates", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name, fields: st.meta_extra || [] }),
                });
                const data = await r.json();
                TEMPLATES = data.templates || TEMPLATES;
                AUTO_TPL = data.auto ?? AUTO_TPL;
                bling.tplChoice = name;
                renderPanel(node);
            } catch (e) { /* ignore */ }
        });
        const tplDel = el("div", "bling-btn mini danger", "✕");
        tplDel.title = "Delete the selected template";
        tplDel.addEventListener("click", async () => {
            const name = tplSel.value;
            if (!name) return;
            try {
                const r = await api.fetchApi("/imagesavebling/templates", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name, delete: true }),
                });
                const data = await r.json();
                TEMPLATES = data.templates || TEMPLATES;
                AUTO_TPL = data.auto ?? AUTO_TPL;
                if (bling.tplChoice === name) bling.tplChoice = "";
                renderPanel(node);
            } catch (e) { /* ignore */ }
        });
        E.panel.appendChild(row(null, add, tplSel, tplAuto, tplName, tplSave, tplDel));
    }

    if (bling.tab === "mask") {
        E.panel.appendChild(row(null,
            pill("Save mask beside image", st.mask_enabled,
                (v) => set({ mask_enabled: v }))));
        const dim = (elm) => { if (!st.mask_enabled) elm.classList.add("bling-dim"); return elm; };
        E.panel.appendChild(dim(row("Source", seg(
            [["input", "MASK input"], ["person", "Person parts"]],
            st.mask_source, (v) => set({ mask_source: v })))));

        if (st.mask_source === "person") {
            const parts = el("div", "bling-row");
            for (const p of ["face", "hair", "body", "clothes", "background"]) {
                const on = (st.mask_parts || []).includes(p);
                parts.appendChild(pill(p, on, (v) => {
                    const cur = new Set(st.mask_parts || []);
                    if (v) cur.add(p); else cur.delete(p);
                    set({ mask_parts: [...cur] });
                }));
            }
            E.panel.appendChild(dim(row("Parts", parts)));
            const c = el("input"); c.type = "range"; c.min = "5"; c.max = "95";
            c.value = String(Math.round((st.mask_confidence ?? 0.4) * 100));
            const cv = el("div", "bling-count", (st.mask_confidence ?? 0.4).toFixed(2));
            c.addEventListener("input", () => { cv.textContent = (c.value / 100).toFixed(2); });
            c.addEventListener("change", () => set({ mask_confidence: c.value / 100 }, false));
            c.addEventListener("pointerdown", (e) => e.stopPropagation());
            E.panel.appendChild(dim(row("Confid.", c, cv,
                pill("Refine", st.mask_refine, (v) => set({ mask_refine: v })))));
            if (st.mask_enabled) {
                fetchCaps().then((caps) => {
                    if (!caps.mediapipe && bling.tab === "mask") {
                        E.panel.appendChild(el("div", "bling-note",
                            "mediapipe is not installed — automatic masks will be "
                            + "skipped. Install with:  pip install mediapipe"));
                    }
                });
            }
        }
        E.panel.appendChild(dim(row("Suffix",
            textInput(st.mask_suffix, "_mask", (v) => set({ mask_suffix: v }, false), "grow"),
            pill("Invert", st.mask_invert, (v) => set({ mask_invert: v })))));
    }

    if (bling.tab === "watermark") {
        E.panel.appendChild(row(null,
            pill("Watermark saved images", st.watermark_enabled,
                (v) => set({ watermark_enabled: v }))));
        const dim = (elm) => { if (!st.watermark_enabled) elm.classList.add("bling-dim"); return elm; };

        const prev = el("img", "bling-wmprev");
        if (st.watermark_image?.filename) prev.src = viewUrl(st.watermark_image, 0, true);
        const chooseBtn = el("div", "bling-btn mini", "Choose PNG…");
        const wmName = el("div", "bling-info", st.watermark_image?.filename || "none");
        const fi = document.createElement("input");
        fi.type = "file";
        fi.accept = "image/png";
        fi.style.display = "none";
        fi.addEventListener("change", async () => {
            const file = fi.files?.[0];
            if (!file) return;
            const form = new FormData();
            form.append("image", file);
            form.append("type", "input");
            form.append("subfolder", "watermarks");
            form.append("overwrite", "true");
            try {
                const r = await api.fetchApi("/upload/image", { method: "POST", body: form });
                const data = await r.json();
                if (data.name) {
                    set({ watermark_image: { filename: data.name,
                        subfolder: data.subfolder || "watermarks",
                        type: data.type || "input" } });
                }
            } catch (e) { console.warn("[ImageSaveBling] watermark upload failed", e); }
        });
        chooseBtn.addEventListener("click", () => fi.click());
        E.panel.appendChild(dim(row("Image", prev, chooseBtn, wmName, fi)));

        const sc = el("input"); sc.type = "range"; sc.min = "2"; sc.max = "60";
        sc.value = String(Math.round((st.watermark_scale ?? 0.15) * 100));
        const scv = el("div", "bling-count", Math.round((st.watermark_scale ?? 0.15) * 100) + "%");
        sc.addEventListener("input", () => { scv.textContent = sc.value + "%"; });
        sc.addEventListener("change", () => set({ watermark_scale: sc.value / 100 }, false));
        sc.addEventListener("pointerdown", (e) => e.stopPropagation());
        const scRow = row("Scale", sc, scv);
        scRow.title = "Watermark width as a proportion of the image width";
        E.panel.appendChild(dim(scRow));

        const inset = textInput(String(st.watermark_inset ?? 24), "", (v) => {
            set({ watermark_inset: Math.max(0, parseInt(v, 10) || 0) }, false);
        }, "tiny");
        inset.title = "Distance from the chosen edges, in pixels";
        const posGrid = el("div", "bling-pos");
        for (const p of ["tl", "tc", "tr", "cl", "cc", "cr", "bl", "bc", "br"]) {
            const cell = el("div", p === (st.watermark_position || "br") ? "on" : "");
            cell.title = { t: "top", c: "center", b: "bottom" }[p[0]] + " "
                + { l: "left", c: "center", r: "right" }[p[1]];
            cell.addEventListener("click", () => set({ watermark_position: p }));
            posGrid.appendChild(cell);
        }
        E.panel.appendChild(dim(row("Inset px", inset,
            el("div", "bling-lab", "Position"), posGrid)));

        const op = el("input"); op.type = "range"; op.min = "10"; op.max = "100";
        op.value = String(Math.round((st.watermark_opacity ?? 1) * 100));
        const opv = el("div", "bling-count", Math.round((st.watermark_opacity ?? 1) * 100) + "%");
        op.addEventListener("input", () => { opv.textContent = op.value + "%"; });
        op.addEventListener("change", () => set({ watermark_opacity: op.value / 100 }, false));
        op.addEventListener("pointerdown", (e) => e.stopPropagation());
        E.panel.appendChild(dim(row("Opacity", op, opv)));

        if (st.watermark_enabled && st.mode === "hold") {
            E.panel.appendChild(el("div", "bling-note",
                "Held images stay clean — the watermark is applied when you "
                + "save them from the gallery."));
        }
    }

    if (bling.tab === "presets") {
        E.panel.appendChild(el("div", "bling-note",
            "A Node Preset captures the settings from EVERY tab — output, "
            + "naming, metadata, mask and watermark — in one named bundle. "
            + "New nodes automatically start with your last-used settings."));

        // apply / delete
        const psSel = el("select", "bling-in");
        psSel.appendChild(el("option", "", "— apply a preset —"));
        for (const name of Object.keys(PRESETS)) {
            const o = el("option", "", name);
            o.value = name;
            psSel.appendChild(o);
        }
        psSel.addEventListener("change", () => {
            const p = PRESETS[psSel.value];
            if (p) {
                for (const k of Object.keys(DEFAULTS)) {
                    if (k !== "uuid" && k in p) {
                        st[k] = JSON.parse(JSON.stringify(p[k]));
                    }
                }
                writeConfig(node);
                renderPanel(node);
                updateExample(node);
            }
        });
        const psDel = el("div", "bling-btn mini danger", "✕");
        psDel.title = "Delete the selected preset";
        psDel.addEventListener("click", async () => {
            const name = psSel.value;
            if (!name) return;
            try {
                const r = await api.fetchApi("/imagesavebling/presets", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name, delete: true }),
                });
                PRESETS = (await r.json()).presets || PRESETS;
                renderPanel(node);
            } catch (e) { /* ignore */ }
        });
        E.panel.appendChild(row("Apply", psSel, psDel));

        // save-as, with per-group include toggles
        bling.psInc = bling.psInc
            || { output: true, naming: true, metadata: true, mask: true, watermark: true };
        const incRow = el("div", "bling-row");
        for (const g of Object.keys(GROUPS)) {
            incRow.appendChild(pill(GROUP_LABELS[g], bling.psInc[g], (v) => {
                bling.psInc[g] = v;
                renderPanel(node);
            }));
        }
        E.panel.appendChild(row("Include", incRow));
        const psName = textInput("", "preset name", () => {}, "grow");
        const psSave = el("div", "bling-btn mini save", "Save preset");
        psSave.title = "Save the included groups' current settings as a named preset";
        psSave.addEventListener("click", async () => {
            const name = psName.value.trim();
            if (!name) return;
            const cfg = {};
            for (const [g, keys] of Object.entries(GROUPS)) {
                if (!bling.psInc[g]) continue;
                for (const k of keys) cfg[k] = st[k];
            }
            try {
                const r = await api.fetchApi("/imagesavebling/presets", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name, config: cfg }),
                });
                PRESETS = (await r.json()).presets || PRESETS;
                renderPanel(node);
            } catch (e) { /* ignore */ }
        });
        E.panel.appendChild(row("Save as", psName, psSave));
        const excluded = Object.keys(GROUPS).filter((g) => !bling.psInc[g]);
        if (excluded.length) {
            E.panel.appendChild(el("div", "bling-note",
                "Excluded from the next save: "
                + excluded.map((g) => GROUP_LABELS[g]).join(", ")
                + ". Applying a preset only touches the groups it captured."));
        }
    }
}

// ------------------------------------------------------------------ lightbox
//
// Fullscreen review: scroll zooms around the cursor, drag pans, double-click
// flips between fit and 1:1 pixels. Arrows navigate, S stars, Enter saves a
// held image, Delete discards it, M shows the mask, holding C flips to the
// pinned compare target, Esc closes.

function buildLightbox(node) {
    const bling = blingState(node);
    if (bling.lbEls) return bling.lbEls;
    const L = (bling.lbEls = {});

    L.root = el("div", "bling-lb");
    L.img = el("img");
    L.root.appendChild(L.img);

    L.top = el("div", "bling-lb-top");
    L.fname = el("div", "bling-fname");
    L.star = el("div", "bling-ico", "☆");
    L.star.title = "Star (S)";
    L.star.addEventListener("click", () => {
        const rec = bling.entries[bling.sel];
        if (rec) setStar(node, rec, !rec.starred);
    });
    L.mask = el("div", "bling-ico", "mask");
    L.mask.title = "Toggle mask (M)";
    L.mask.addEventListener("click", () => {
        bling.showMask = !bling.showMask;
        bling.lb.scale = null;
        renderGallery(node);
    });
    L.save = el("div", "bling-btn save mini", "💾 Save this one");
    L.save.title = "Save this held image (Enter)";
    L.save.addEventListener("click", () => {
        const rec = bling.entries[bling.sel];
        if (rec?.held) commitHeld(node, [rec.id]);
    });
    L.discard = el("div", "bling-btn danger mini", "✕ Discard");
    L.discard.title = "Discard this held image (Delete)";
    L.discard.addEventListener("click", () => {
        const rec = bling.entries[bling.sel];
        if (rec?.held) discardHeld(node, rec);
    });
    L.toInput = el("div", "bling-ico", "📥");
    L.toInput.title = "Save a copy to ComfyUI's input folder (for Load Image)";
    L.toInput.addEventListener("click", () => promptToInput(node, L.root));
    L.close = el("div", "bling-ico", "✕");
    L.close.title = "Close (Esc)";
    L.close.addEventListener("click", () => closeLightbox(node));
    for (const c of [L.fname, L.star, L.mask, L.save, L.discard, L.toInput,
                     L.close]) {
        L.top.appendChild(c);
    }
    L.root.appendChild(L.top);

    L.bot = el("div", "bling-lb-bot");
    L.info = el("div", "");
    L.hint = el("div", "bling-lb-hint",
        "scroll zoom · drag pan · double-click 1:1 · ←/→ · S star · hold C compare");
    L.idx = el("div", "");
    L.bot.appendChild(L.info);
    L.bot.appendChild(L.hint);
    L.bot.appendChild(L.idx);
    L.root.appendChild(L.bot);

    L.prev = el("div", "bling-nav prev", "‹");
    L.next = el("div", "bling-nav next", "›");
    L.prev.style.opacity = L.next.style.opacity = "0.6";
    L.prev.addEventListener("click", () => step(node, -1));
    L.next.addEventListener("click", () => step(node, +1));
    L.root.appendChild(L.prev);
    L.root.appendChild(L.next);

    const lb = () => bling.lb;
    L.root.addEventListener("wheel", (e) => {
        e.preventDefault();
        const s = lb().scale ?? lb().fitScale ?? 1;
        const ns = Math.min(12, Math.max((lb().fitScale || 0.05) * 0.2,
            s * Math.exp(-e.deltaY * 0.0015)));
        const cx = e.clientX - window.innerWidth / 2;
        const cy = e.clientY - window.innerHeight / 2;
        lb().tx = cx - (cx - lb().tx) * (ns / s);
        lb().ty = cy - (cy - lb().ty) * (ns / s);
        lb().scale = ns;
        applyLightboxTransform(node);
    }, { passive: false });

    L.img.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        L.img.setPointerCapture(e.pointerId);
        L.drag = { x: e.clientX, y: e.clientY };
        L.img.style.cursor = "grabbing";
    });
    L.img.addEventListener("pointermove", (e) => {
        if (!L.drag) return;
        bling.lb.tx += e.clientX - L.drag.x;
        bling.lb.ty += e.clientY - L.drag.y;
        L.drag = { x: e.clientX, y: e.clientY };
        applyLightboxTransform(node);
    });
    const endDrag = () => { L.drag = null; L.img.style.cursor = "grab"; };
    L.img.addEventListener("pointerup", endDrag);
    L.img.addEventListener("pointercancel", endDrag);
    L.img.addEventListener("dblclick", (e) => {
        const fit = bling.lb.fitScale || 1;
        const s = bling.lb.scale ?? fit;
        if (Math.abs(s - fit) > 0.001) {
            bling.lb.scale = null; // back to fit
        } else {
            const cx = e.clientX - window.innerWidth / 2;
            const cy = e.clientY - window.innerHeight / 2;
            bling.lb.tx = cx - (cx - bling.lb.tx) * (1 / s);
            bling.lb.ty = cy - (cy - bling.lb.ty) * (1 / s);
            bling.lb.scale = 1;
        }
        applyLightboxTransform(node);
    });
    L.root.addEventListener("mousedown", (e) => {
        if (e.target === L.root) closeLightbox(node);
    });
    L.img.addEventListener("load", () => {
        if (bling.lb?.open) applyLightboxTransform(node);
    });
    return L;
}

function applyLightboxTransform(node) {
    const bling = blingState(node);
    const L = bling.lbEls;
    const lb = bling.lb;
    if (!L || !lb?.open || !L.img.naturalWidth) return;
    const nw = L.img.naturalWidth, nh = L.img.naturalHeight;
    lb.fitScale = Math.min(window.innerWidth / nw, window.innerHeight / nh);
    if (lb.scale == null) { lb.scale = lb.fitScale; lb.tx = 0; lb.ty = 0; }
    const s = lb.scale;
    L.img.style.transform =
        `translate(${lb.tx - (nw * s) / 2}px, ${lb.ty - (nh * s) / 2}px) scale(${s})`;
    L.img.classList.toggle("pixel", s >= 3);
}

function renderLightbox(node) {
    const bling = blingState(node);
    const L = bling.lbEls;
    if (!L || !bling.lb?.open) return;
    const rec = bling.entries[bling.sel];
    if (!rec) { closeLightbox(node); return; }
    const pinRec = bling.pinId ? bling.entries.find((r) => r.id === bling.pinId) : null;
    const comparing = pinRec && pinRec.id !== rec.id;
    const showRec = (bling.lb.showA && comparing) ? pinRec : rec;
    const showMask = bling.showMask && showRec.mask && !bling.lb.showA;
    const url = showMask ? viewUrl(showRec.mask, showRec.ts)
                         : viewUrl(showRec, showRec.ts);
    if (L.img.getAttribute("src") !== url) L.img.src = url;
    L.fname.textContent =
        (bling.lb.showA && comparing ? "A (pinned)  " : "")
        + (showRec.subfolder ? showRec.subfolder + "/" : "") + showRec.filename
        + (showMask ? "  (mask)" : "");
    L.info.textContent = [
        rec.seed != null ? `seed ${rec.seed}` : "",
        rec.model || "",
        rec.held ? "HELD — not saved" : "",
    ].filter(Boolean).join(" · ");
    const vis = visibleIdx(bling);
    L.idx.textContent = `${vis.indexOf(bling.sel) + 1} / ${vis.length}`
        + (bling.starFilter ? " ★" : "");
    L.star.textContent = rec.starred ? "★" : "☆";
    L.star.classList.toggle("on", !!rec.starred);
    L.mask.style.display = rec.mask ? "" : "none";
    L.save.style.display = rec.held ? "" : "none";
    L.discard.style.display = rec.held ? "" : "none";
    applyLightboxTransform(node);
}

function openLightbox(node) {
    const bling = blingState(node);
    if (!bling.entries.length) return;
    const L = buildLightbox(node);
    bling.lb = { open: true, scale: null, tx: 0, ty: 0, fitScale: null, showA: false };
    document.body.appendChild(L.root);

    bling.lbKeyDown = (e) => {
        const t = e.target;
        if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
        const rec = bling.entries[bling.sel];
        let handled = true;
        if (e.key === "Escape") closeLightbox(node);
        else if (e.key === "ArrowLeft") step(node, -1);
        else if (e.key === "ArrowRight") step(node, +1);
        else if (e.key === "s" || e.key === "S") { if (rec) setStar(node, rec, !rec.starred); }
        else if (e.key === "Enter") { if (rec?.held) commitHeld(node, [rec.id]); }
        else if (e.key === "Delete" || e.key === "Backspace") {
            if (rec?.held) discardHeld(node, rec);
        }
        else if (e.key === "m" || e.key === "M") {
            bling.showMask = !bling.showMask; bling.lb.scale = null; renderGallery(node);
        }
        else if ((e.key === "c" || e.key === "C") && !e.repeat) {
            bling.lb.showA = true; renderLightbox(node);
        }
        else handled = false;
        if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    bling.lbKeyUp = (e) => {
        if (e.key === "c" || e.key === "C") {
            bling.lb.showA = false; renderLightbox(node);
        }
    };
    window.addEventListener("keydown", bling.lbKeyDown, true);
    window.addEventListener("keyup", bling.lbKeyUp, true);
    renderLightbox(node);
}

function closeLightbox(node) {
    const bling = blingState(node);
    if (!bling.lb?.open) return;
    bling.lb.open = false;
    window.removeEventListener("keydown", bling.lbKeyDown, true);
    window.removeEventListener("keyup", bling.lbKeyUp, true);
    bling.lbEls?.root.remove();
}

// ------------------------------------------------------------------ UI assembly

function buildUI(node) {
    injectCSS();
    const bling = blingState(node);
    const E = bling.els;

    // Hide the config transport widget — the DOM panel owns it.
    const cw = findWidget(node, "config");
    if (cw) {
        cw.hidden = true;
        cw.computeSize = () => [0, -4];
        cw.type = "hidden_bling_config";
        if (cw.element) cw.element.style.display = "none";
        if (cw.inputEl) cw.inputEl.style.display = "none";
    }

    const root = el("div", "bling-root");
    root.addEventListener("pointerdown", (e) => e.stopPropagation());
    root.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

    // ---- viewer
    E.viewer = el("div", "bling-viewer");
    E.mainImg = el("img");
    E.empty = el("div", "bling-empty"); // text set per-render (differs under ★ filter)
    E.badge = el("div", "bling-badge");
    E.heldBadge = el("div", "bling-heldbadge", "HELD — not saved");
    E.navPrev = el("div", "bling-nav prev", "‹");
    E.navNext = el("div", "bling-nav next", "›");
    E.navPrev.addEventListener("click", () => step(node, -1));
    E.navNext.addEventListener("click", () => step(node, +1));

    E.heldRow = el("div", "bling-heldrow");
    const saveBtn = el("div", "bling-btn save", "💾 Save this one");
    saveBtn.addEventListener("click", () => {
        const rec = bling.entries[bling.sel];
        if (rec?.held) commitHeld(node, [rec.id]);
    });
    const discardBtn = el("div", "bling-btn danger", "✕ Discard");
    discardBtn.addEventListener("click", () => {
        const rec = bling.entries[bling.sel];
        if (rec?.held) discardHeld(node, rec);
    });
    E.heldRow.appendChild(saveBtn);
    E.heldRow.appendChild(discardBtn);

    E.nameBar = el("div", "bling-namebar");
    E.fname = el("div", "bling-fname");
    E.info = el("div", "bling-info");
    E.starBtn = el("div", "bling-ico", "☆");
    E.starBtn.title = "Star this image (S in fullscreen) — the ★ filter shows "
        + "starred only, and “Keep starred held images” saves starred holds "
        + "and discards the held rest";
    E.starBtn.addEventListener("click", () => {
        const rec = bling.entries[bling.sel];
        if (rec) setStar(node, rec, !rec.starred);
    });
    E.pinBtn = el("div", "bling-ico", "A");
    E.pinBtn.title = "Pin as compare target A — then hold the A⇄B button "
        + "(or C in fullscreen) on any other image to flip between them";
    E.pinBtn.addEventListener("click", () => {
        const rec = bling.entries[bling.sel];
        if (!rec) return;
        bling.pinId = bling.pinId === rec.id ? null : rec.id;
        renderGallery(node);
    });
    E.wfBtn = el("div", "bling-ico", "⟲ wf");
    E.wfBtn.title = "Load the workflow that made this image into the canvas "
        + "(click again to confirm — replaces the current workflow)";
    armable(E.wfBtn, "Load?", () => restoreWorkflow(node));
    E.maskBtn = el("div", "bling-ico", "mask");
    E.maskBtn.title = "Toggle between image and its saved mask";
    E.maskBtn.addEventListener("click", () => {
        bling.showMask = !bling.showMask;
        renderGallery(node);
    });
    const openBtn = el("div", "bling-ico", "↗");
    openBtn.title = "Open full size in a new tab";
    openBtn.addEventListener("click", () => {
        const rec = bling.entries[bling.sel];
        if (rec) window.open(viewUrl(rec, rec.ts), "_blank");
    });
    E.inpBtn = el("div", "bling-ico", "📥");
    E.inpBtn.title = "Save a copy to ComfyUI's input folder (for Load Image) — "
        + "you'll be asked for a filename";
    E.inpBtn.addEventListener("click", () => promptToInput(node, E.viewer));
    const fsBtn = el("div", "bling-ico", "⛶");
    fsBtn.title = "Fullscreen review (or click the image) — zoom, arrows, "
        + "S star, Enter save, Del discard";
    fsBtn.addEventListener("click", () => openLightbox(node));
    for (const c of [E.fname, E.info, E.starBtn, E.pinBtn, E.wfBtn, E.maskBtn,
                     E.inpBtn, openBtn, fsBtn]) {
        E.nameBar.appendChild(c);
    }

    E.abBtn = el("div", "bling-abbtn", "A⇄B");
    E.abBtn.title = "Hold to show the pinned image (A); release for this one (B)";
    const abDown = (e) => { e.preventDefault(); bling.abShow = true; renderGallery(node); };
    const abUp = () => { if (bling.abShow) { bling.abShow = false; renderGallery(node); } };
    E.abBtn.addEventListener("pointerdown", abDown);
    E.abBtn.addEventListener("pointerup", abUp);
    E.abBtn.addEventListener("pointerleave", abUp);
    E.abBadge = el("div", "bling-abbadge");

    E.mainImg.style.cursor = "zoom-in";
    E.mainImg.addEventListener("click", () => openLightbox(node));

    for (const c of [E.mainImg, E.empty, E.badge, E.heldBadge, E.navPrev,
                     E.navNext, E.abBtn, E.abBadge, E.heldRow, E.nameBar]) {
        E.viewer.appendChild(c);
    }
    root.appendChild(E.viewer);

    // ---- slider row
    const ctl = el("div", "bling-ctl");
    E.slider = el("input");
    E.slider.type = "range";
    E.slider.min = "0"; E.slider.max = "0"; E.slider.value = "0";
    E.slider.addEventListener("input", () => {
        const vis = visibleIdx(bling);
        const v = vis[parseInt(E.slider.value, 10) || 0];
        if (v != null) bling.sel = v;
        bling.showMask = false;
        renderGallery(node);
    });
    E.count = el("div", "bling-count", "0/0");
    E.filterBtn = el("div", "bling-btn mini", "★");
    E.filterBtn.title = "Show only starred images";
    E.filterBtn.addEventListener("click", () => {
        bling.starFilter = !bling.starFilter;
        renderGallery(node);
    });
    E.clear = el("div", "bling-btn mini", "🗑");
    E.clear.title = "Clear session history (saved files stay on disk; held images are discarded)";
    E.clear.addEventListener("click", () => {
        if (!bling.clearArmed) {
            bling.clearArmed = true;
            E.clear.textContent = "Sure?";
            E.clear.classList.add("danger");
            setTimeout(() => {
                bling.clearArmed = false;
                E.clear.textContent = "🗑";
                E.clear.classList.remove("danger");
            }, 2500);
            return;
        }
        bling.clearArmed = false;
        clearHistory(node);
    });
    ctl.appendChild(E.slider);
    ctl.appendChild(E.count);
    ctl.appendChild(E.filterBtn);
    ctl.appendChild(E.clear);
    root.appendChild(ctl);

    // Bulk triage row — only visible while held images exist.
    E.bulk = el("div", "bling-ctl");
    E.bulk.style.display = "none";
    E.saveAll = el("div", "bling-btn save mini", "💾 Save all");
    E.saveAll.addEventListener("click", () => commitHeld(node, []));
    E.keepStar = el("div", "bling-btn save mini", "★ Keep starred");
    E.keepStar.title = "Save every starred held image, discard the held rest";
    armable(E.keepStar, "Keep ★ held, drop rest?", () => keepStarred(node));
    E.discardAll = el("div", "bling-btn mini", "✕ Discard all");
    E.discardAll.title = "Discard every held image";
    armable(E.discardAll, "Discard all held?", () => discardMany(node, [], true));
    E.bulk.appendChild(E.saveAll);
    E.bulk.appendChild(E.keepStar);
    E.bulk.appendChild(E.discardAll);
    root.appendChild(E.bulk);

    // ---- filmstrip
    E.strip = el("div", "bling-strip");
    E.strip.addEventListener("wheel", (e) => {
        // vertical wheel scrolls the strip horizontally
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            E.strip.scrollLeft += e.deltaY;
            e.preventDefault();
        }
    }, { passive: false });
    root.appendChild(E.strip);

    // ---- tabs + panel
    const tabs = el("div", "bling-tabs");
    E.tabs = {};
    for (const [key, label] of [["output", "Output"], ["naming", "Naming"],
                                ["metadata", "Meta"], ["mask", "Mask"],
                                ["watermark", "W-mark"], ["presets", "Presets"]]) {
        const t = el("div", "bling-tab", label);
        t.addEventListener("click", () => {
            bling.tab = key;
            if (key === "metadata") fetchTemplates().then(() => renderPanel(node));
            if (key === "presets") fetchPresets().then(() => renderPanel(node));
            renderPanel(node);
        });
        E.tabs[key] = t;
        tabs.appendChild(t);
    }
    root.appendChild(tabs);
    E.panel = el("div", "bling-panel");
    root.appendChild(E.panel);

    const widget = node.addDOMWidget("bling_ui", "bling_panel", root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => 470,
    });
    try {
        Object.defineProperty(widget, "width", {
            configurable: true, enumerable: true,
            get() { return node.size ? node.size[0] : undefined; },
            set(_v) { /* derived from the node */ },
        });
    } catch (e) { /* ignore */ }

    renderGallery(node);
    renderPanel(node);
}

function step(node, d) {
    const bling = blingState(node);
    const vis = visibleIdx(bling);
    if (!vis.length) return;
    const pos = vis.indexOf(bling.sel);
    const next = pos < 0 ? 0 : ((pos + d) % vis.length + vis.length) % vis.length;
    bling.sel = vis[next];
    bling.showMask = false;
    if (bling.lb?.open) bling.lb.scale = null; // re-fit the lightbox per image
    renderGallery(node);
}

// ------------------------------------------------------------------ extension

app.registerExtension({
    name: "ImageSaveBling.UI",

    async setup() {
        // Queue status changes ARE broadcast to every tab (unlike `executed`),
        // so idle windows learn about runs finished elsewhere shortly after.
        api.addEventListener("status", () => refetchAll(600));
        window.addEventListener("focus", () => refetchAll(50));
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) refetchAll(50);
        });
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_NAME) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            origOnNodeCreated?.apply(this, arguments);
            buildUI(this);
            const min = [340, 560];
            if (this.size[0] < min[0]) this.size[0] = min[0];
            if (this.size[1] < min[1]) this.size[1] = min[1];
            // Fresh node (not a workflow load — onConfigure covers that):
            // mint the UUID and pull any prior-session history.
            setTimeout(async () => {
                syncFromWidget(this);
                const bling = blingState(this);
                if (bling.isFresh) {
                    // Fresh nodes start from the last-used settings (all tabs),
                    // then the auto credit template, if one is starred, wins.
                    await fetchPresets();
                    if (LASTCFG) {
                        for (const k of Object.keys(DEFAULTS)) {
                            if (k !== "uuid" && k in LASTCFG) {
                                bling.state[k] = JSON.parse(JSON.stringify(LASTCFG[k]));
                            }
                        }
                        writeConfig(this);
                    }
                    await applyAutoTemplate(this);
                }
                renderPanel(this);
                fetchHistory(this);
            }, 60);
        };

        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            origOnConfigure?.apply(this, arguments);
            // Widget values are restored around this call — defer the resync.
            setTimeout(() => {
                syncFromWidget(this);
                renderPanel(this);
                updateExample(this);
                fetchHistory(this);
            }, 60);
        };

        const origOnExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            origOnExecuted?.apply(this, arguments);
            try {
                const records = message?.bling;
                if (Array.isArray(records) && records.length) {
                    appendRecords(this, records);
                }
            } catch (e) { /* never break execution handling */ }
        };
    },
});
