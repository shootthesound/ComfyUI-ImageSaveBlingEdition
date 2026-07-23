"""Image Save - Bling Edition — session-recovery manifests, credit templates and routes.

Every save appends a record to a per-node manifest (keyed by the UUID the
frontend stores in the node's config), so the gallery survives page reloads
and ComfyUI restarts. Held (temp) records whose files vanished — e.g. the
temp dir was cleared by a restart — are pruned on load.
"""

import json
import os
import re
import threading

import folder_paths

from . import bling_saver

MAX_ENTRIES = 500

_LOCK = threading.Lock()


def _base_dir():
    root = os.path.join(folder_paths.get_user_directory(), "default")
    d = os.path.join(root, "ImageSaveBlingEdition")
    old = os.path.join(root, "ImageSavePro")
    # one-time migration from the pre-rename storage dir
    if os.path.isdir(old) and not os.path.isdir(d):
        try:
            os.rename(old, d)
        except OSError:
            pass
    os.makedirs(os.path.join(d, "history"), exist_ok=True)
    return d


def _safe_uuid(uid):
    return re.sub(r"[^a-zA-Z0-9_-]", "", str(uid or ""))[:64]


def _hist_file(uid):
    return os.path.join(_base_dir(), "history", f"{_safe_uuid(uid)}.json")


def load(uid):
    try:
        with open(_hist_file(uid), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _write(uid, entries):
    try:
        with open(_hist_file(uid), "w", encoding="utf-8") as f:
            json.dump(entries, f)
    except OSError as e:
        print(f"[ImageSaveBling] history write failed: {e}")


def append(uid, records):
    if not _safe_uuid(uid):
        return
    with _LOCK:
        entries = load(uid)
        entries.extend(records)
        # Trim oldest past the cap; never delete saved outputs, but held temp
        # files being trimmed would be orphaned — remove those from disk.
        while len(entries) > MAX_ENTRIES:
            old = entries.pop(0)
            if old.get("held"):
                bling_saver.discard_held(old)
        _write(uid, entries)


def prune(uid):
    """Drop records whose files no longer exist. Returns the pruned list."""
    with _LOCK:
        entries = load(uid)
        kept = [r for r in entries if os.path.exists(bling_saver.record_path(r))]
        if len(kept) != len(entries):
            _write(uid, kept)
        return kept


def update(uid, new_rec):
    with _LOCK:
        entries = load(uid)
        for i, r in enumerate(entries):
            if r.get("id") == new_rec.get("id"):
                entries[i] = new_rec
                break
        _write(uid, entries)


def remove(uid, rec_id):
    with _LOCK:
        entries = load(uid)
        entries = [r for r in entries if r.get("id") != rec_id]
        _write(uid, entries)


def set_starred(uid, rec_id, starred):
    with _LOCK:
        entries = load(uid)
        for r in entries:
            if r.get("id") == rec_id:
                r["starred"] = bool(starred)
        _write(uid, entries)


def clear(uid):
    with _LOCK:
        for r in load(uid):
            if r.get("held"):
                bling_saver.discard_held(r)
        _write(uid, [])


# ---------------------------------------------------------------- templates

def _tpl_file():
    return os.path.join(_base_dir(), "templates.json")


def load_templates():
    """Returns {"templates": {name: fields}, "auto": name-or-""}.
    Reads the legacy flat {name: fields} layout transparently."""
    try:
        with open(_tpl_file(), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {"templates": {}, "auto": ""}
    if isinstance(data, dict) and isinstance(data.get("templates"), dict):
        return {"templates": data["templates"], "auto": str(data.get("auto", ""))}
    return {"templates": data if isinstance(data, dict) else {}, "auto": ""}


def save_templates(store):
    try:
        with open(_tpl_file(), "w", encoding="utf-8") as f:
            json.dump(store, f, indent=1)
    except OSError as e:
        print(f"[ImageSaveBling] template write failed: {e}")


# ---------------------------------------------------------------- presets

def _presets_file():
    return os.path.join(_base_dir(), "presets.json")


def _last_file():
    return os.path.join(_base_dir(), "lastconfig.json")


def load_presets():
    try:
        with open(_presets_file(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def save_presets(presets):
    try:
        with open(_presets_file(), "w", encoding="utf-8") as f:
            json.dump(presets, f, indent=1)
    except OSError as e:
        print(f"[ImageSaveBling] preset write failed: {e}")


def load_last():
    try:
        with open(_last_file(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def save_last(cfg):
    try:
        with open(_last_file(), "w", encoding="utf-8") as f:
            json.dump(cfg, f)
    except OSError as e:
        print(f"[ImageSaveBling] last-config write failed: {e}")


# ---------------------------------------------------------------- routes

try:
    from server import PromptServer
    from aiohttp import web

    routes = PromptServer.instance.routes

    @routes.get("/imagesavebling/history")
    async def _bling_history_route(request):
        uid = request.query.get("uuid", "")
        return web.json_response({"entries": prune(uid)})

    @routes.get("/imagesavebling/caps")
    async def _bling_caps(request):
        try:
            from . import bling_mask
            mp_ok = bling_mask.available()
        except Exception:
            mp_ok = False
        return web.json_response({"mediapipe": mp_ok})

    @routes.post("/imagesavebling/clear")
    async def _bling_clear(request):
        data = await request.json()
        clear(data.get("uuid", ""))
        return web.json_response({"ok": True})

    @routes.post("/imagesavebling/commit")
    async def _bling_commit(request):
        data = await request.json()
        uid = data.get("uuid", "")
        ids = set(data.get("ids", []))
        updated, errors = [], []
        for rec in load(uid):
            if rec.get("held") and (not ids or rec.get("id") in ids):
                try:
                    new_rec = bling_saver.commit_held(rec)
                    update(uid, new_rec)
                    updated.append(new_rec)
                except Exception as e:
                    print(f"[ImageSaveBling] commit failed for {rec.get('id')}: {e}")
                    errors.append({"id": rec.get("id"), "error": str(e)})
        return web.json_response({"ok": not errors, "entries": updated, "errors": errors})

    @routes.post("/imagesavebling/discard")
    async def _bling_discard(request):
        data = await request.json()
        uid = data.get("uuid", "")
        if data.get("all_held"):
            ids = {r["id"] for r in load(uid) if r.get("held")}
        elif isinstance(data.get("ids"), list):
            ids = set(data["ids"])
        else:
            ids = {data.get("id", "")}
        removed = []
        for rec in load(uid):
            if rec.get("id") in ids:
                if rec.get("held"):
                    bling_saver.discard_held(rec)
                remove(uid, rec["id"])
                removed.append(rec["id"])
        return web.json_response({"ok": True, "removed": removed})

    @routes.post("/imagesavebling/star")
    async def _bling_star(request):
        data = await request.json()
        set_starred(data.get("uuid", ""), data.get("id", ""),
                    data.get("starred", False))
        return web.json_response({"ok": True})

    @routes.post("/imagesavebling/to_input")
    async def _bling_to_input(request):
        data = await request.json()
        uid = data.get("uuid", "")
        rid = data.get("id", "")
        for rec in load(uid):
            if rec.get("id") == rid:
                try:
                    final = bling_saver.save_to_input(rec, str(data.get("name", "")))
                    return web.json_response({"ok": True, "filename": final})
                except Exception as e:
                    print(f"[ImageSaveBling] save to input failed: {e}")
                    return web.json_response({"ok": False, "error": str(e)})
        return web.json_response({"ok": False, "error": "unknown image"})

    @routes.get("/imagesavebling/workflow")
    async def _bling_workflow(request):
        uid = request.query.get("uuid", "")
        rid = request.query.get("id", "")
        for rec in load(uid):
            if rec.get("id") == rid:
                return web.json_response({"workflow": bling_saver.extract_workflow(rec)})
        return web.json_response({"workflow": None})

    @routes.get("/imagesavebling/templates")
    async def _bling_templates_get(request):
        return web.json_response(load_templates())

    @routes.post("/imagesavebling/templates")
    async def _bling_templates_post(request):
        data = await request.json()
        store = load_templates()
        if "auto" in data and "name" not in data:
            # set/clear the template auto-loaded onto new nodes
            auto = str(data.get("auto", ""))
            store["auto"] = auto if auto in store["templates"] else ""
            save_templates(store)
            return web.json_response({"ok": True, **store})
        name = str(data.get("name", "")).strip()
        if not name:
            return web.json_response({"ok": False, "error": "missing name"})
        if data.get("delete"):
            store["templates"].pop(name, None)
            if store["auto"] == name:
                store["auto"] = ""
        else:
            fields = data.get("fields", [])
            if isinstance(fields, list):
                store["templates"][name] = fields
        save_templates(store)
        return web.json_response({"ok": True, **store})

    @routes.get("/imagesavebling/presets")
    async def _bling_presets_get(request):
        return web.json_response({"presets": load_presets(), "last": load_last()})

    @routes.post("/imagesavebling/presets")
    async def _bling_presets_post(request):
        data = await request.json()
        if "last" in data and "name" not in data:
            cfg = data.get("last")
            if isinstance(cfg, dict):
                cfg.pop("uuid", None)
                save_last(cfg)
            return web.json_response({"ok": True})
        name = str(data.get("name", "")).strip()
        if not name:
            return web.json_response({"ok": False, "error": "missing name"})
        presets = load_presets()
        if data.get("delete"):
            presets.pop(name, None)
        else:
            cfg = data.get("config")
            if isinstance(cfg, dict):
                cfg.pop("uuid", None)
                presets[name] = cfg
        save_presets(presets)
        return web.json_response({"ok": True, "presets": presets})

except Exception as e:
    print(f"[ImageSaveBling] server routes unavailable: {e}")
