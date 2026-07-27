"""Image Save - Bling Edition — save engine.

Filename/subfolder token expansion, metadata embedding (PNG text chunks or
EXIF for JPEG/WebP using the same Make/Model convention as core ComfyUI, so
drag-to-restore keeps working), collision/counter handling, mask companions
and sidecar workflow JSON. Used by the node (live saves and holds) and by the
history routes (committing held images).
"""

import json
import os
import re
import time
import uuid as uuidlib
from datetime import datetime

import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import folder_paths

try:
    from comfy.cli_args import args as _comfy_args
except Exception:
    _comfy_args = None

HELD_SUBFOLDER = "imagesavebling"

DEFAULTS = {
    "uuid": "",
    "mode": "auto",            # auto | hold
    "format": "png",           # png | jpg | webp
    "quality": 90,
    "lossless_webp": False,
    "png_compress": 4,
    "filename": "%prefix%_%counter%",
    "prefix": "ComfyUI",
    "counter_pad": 5,
    "use_subfolder": False,
    "subfolder": "%date%",
    "overwrite": False,
    "save_root": "",           # absolute folder override; "" = ComfyUI's output dir
    "meta_workflow": True,
    "meta_prompt": True,
    "meta_extra": [],          # [{"key": ..., "value": ...}]
    "sidecar_json": False,
    "mask_enabled": False,
    "mask_source": "input",    # input | person
    "mask_parts": ["face"],
    "mask_confidence": 0.4,
    "mask_refine": True,
    "mask_invert": False,
    "mask_suffix": "_mask",
    "watermark_enabled": False,
    "watermark_image": None,    # {"filename", "subfolder", "type"} in the input dir
    "watermark_scale": 0.15,    # fraction of the image width
    "watermark_inset": 24,      # px from the chosen edge(s)
    "watermark_position": "br",  # tl tc tr / cl cc cr / bl bc br
    "watermark_opacity": 1.0,
}

_EXT = {"png": ".png", "jpg": ".jpg", "webp": ".webp"}


def merge_config(config_str):
    cfg = dict(DEFAULTS)
    try:
        loaded = json.loads(config_str) if config_str else {}
        if isinstance(loaded, dict):
            for k in DEFAULTS:
                if k in loaded:
                    cfg[k] = loaded[k]
            if loaded.get("uuid"):
                cfg["uuid"] = loaded["uuid"]
    except Exception as e:
        print(f"[ImageSaveBling] bad config JSON ({e}) — using defaults")
    return cfg


def metadata_disabled():
    return bool(_comfy_args is not None and getattr(_comfy_args, "disable_metadata", False))


# ---------------------------------------------------------------- tokens

_DATE_MAP = (("yyyy", "%Y"), ("yy", "%y"), ("MM", "%m"), ("dd", "%d"),
             ("HH", "%H"), ("mm", "%M"), ("ss", "%S"))


def _fmt_date(fmt, now):
    for a, b in _DATE_MAP:
        fmt = fmt.replace(a, b)
    return now.strftime(fmt)


def extract_prompt_info(prompt):
    """Best-effort seed and model name from the executed prompt graph."""
    seed = None
    model = None
    if isinstance(prompt, dict):
        for nd in prompt.values():
            ins = nd.get("inputs", {}) if isinstance(nd, dict) else {}
            if seed is None:
                for k in ("seed", "noise_seed"):
                    v = ins.get(k)
                    if isinstance(v, (int, float)):
                        seed = int(v)
                        break
            if model is None:
                for k in ("ckpt_name", "unet_name", "model_name"):
                    v = ins.get(k)
                    if isinstance(v, str) and v:
                        model = os.path.splitext(os.path.basename(v.replace("\\", "/")))[0]
                        break
    return seed, model


def build_ctx(cfg, prompt, width, height, index):
    seed, model = extract_prompt_info(prompt)
    return {
        "now": datetime.now(),
        "prefix": cfg.get("prefix", ""),
        "seed": "" if seed is None else seed,
        "model": model or "",
        "width": width,
        "height": height,
        "index": index,
        "format": cfg.get("format", "png"),
    }


def expand(pattern, ctx):
    """Expand every token except %counter% (resolved against the target dir)."""
    out = re.sub(r"%date(?::([^%]+))?%",
                 lambda m: _fmt_date(m.group(1) or "yyyy-MM-dd", ctx["now"]),
                 pattern or "")
    out = out.replace("%time%", ctx["now"].strftime("%H-%M-%S"))
    for k in ("prefix", "seed", "model", "width", "height", "index", "format"):
        out = out.replace(f"%{k}%", str(ctx.get(k, "")))
    return out


# ---------------------------------------------------------------- paths

_ILLEGAL = set('<>:"|?*')


def _clean_segment(seg):
    seg = "".join(c for c in seg if c not in _ILLEGAL and ord(c) >= 32)
    seg = seg.strip(" .")
    return seg


def clean_filename(name):
    name = name.replace("/", "_").replace("\\", "_")
    return _clean_segment(name) or "image"


def clean_subfolder(sub):
    parts = [p for p in re.split(r"[\\/]+", sub or "")]
    parts = [_clean_segment(p) for p in parts]
    parts = [p for p in parts if p and p != ".." and p != "."]
    return "/".join(parts)


def resolve_dir(cfg, ctx):
    """(absolute dir, subfolder-for-/view, custom root-or-None).

    Normally everything lives inside ComfyUI's own output dir. If `save_root`
    is set, that absolute path is the root instead — the subfolder pattern is
    still confined to it (no escaping via ../), same as the default case is
    confined to the output dir. The third return value is the custom root
    when one is in effect, so callers can stamp records with it (files
    outside ComfyUI's own directories aren't reachable through its /view
    route, so the record needs to say where to actually find them)."""
    custom_root = (cfg.get("save_root") or "").strip()
    out_root = os.path.abspath(custom_root if custom_root else folder_paths.get_output_directory())
    sub = ""
    if cfg.get("use_subfolder"):
        # %counter% is per-file and only meaningful in the filename
        pattern = (cfg.get("subfolder", "") or "").replace("%counter%", "")
        sub = clean_subfolder(expand(pattern, ctx))
    full = os.path.join(out_root, *sub.split("/")) if sub else out_root
    full = os.path.abspath(full)
    if os.path.commonpath([full, out_root]) != out_root:
        full, sub = out_root, ""
    os.makedirs(full, exist_ok=True)
    return full, sub, (out_root if custom_root else None)


def _next_counter(dirpath, stem_pattern):
    """Highest existing %counter% match in dirpath (any extension) + 1."""
    rx = re.compile("^" + re.escape(stem_pattern).replace(re.escape("%counter%"), r"(\d+)") + "$")
    best = 0
    try:
        for f in os.listdir(dirpath):
            m = rx.match(os.path.splitext(f)[0])
            if m:
                best = max(best, int(m.group(1)))
    except OSError:
        pass
    return best + 1


def resolve_stem(cfg, ctx, dirpath):
    """Final filename stem for one image, honoring counter and overwrite."""
    stem_pattern = clean_filename(expand(cfg.get("filename", "%prefix%_%counter%"), ctx))
    pad = max(1, int(cfg.get("counter_pad", 5)))
    if "%counter%" in stem_pattern:
        n = _next_counter(dirpath, stem_pattern)
        return stem_pattern.replace("%counter%", str(n).zfill(pad))
    if not cfg.get("overwrite"):
        stem = stem_pattern
        n = 0
        while os.path.exists(os.path.join(dirpath, stem + _EXT[cfg.get("format", "png")])):
            n += 1
            stem = f"{stem_pattern}_{str(n).zfill(4)}"
        return stem
    return stem_pattern


# ---------------------------------------------------------------- metadata

def _png_metadata(cfg, prompt, workflow, force_all=False):
    if metadata_disabled():
        return None
    info = PngInfo()
    if prompt is not None and (force_all or cfg.get("meta_prompt")):
        info.add_text("prompt", json.dumps(prompt))
    if workflow is not None and (force_all or cfg.get("meta_workflow")):
        info.add_text("workflow", json.dumps(workflow))
    if not force_all:
        for f in cfg.get("meta_extra", []) or []:
            k, v = str(f.get("key", "")).strip(), str(f.get("value", ""))
            if k:
                info.add_text(k, v)
    return info


def _exif_metadata(img, cfg, prompt, workflow):
    """Same tag convention as core ComfyUI's WebP saver, so the frontend can
    load workflows straight from a dragged JPEG/WebP."""
    exif = img.getexif()
    if metadata_disabled():
        return exif
    if prompt is not None and cfg.get("meta_prompt"):
        exif[0x0110] = "prompt:{}".format(json.dumps(prompt))          # Model
    if workflow is not None and cfg.get("meta_workflow"):
        exif[0x010F] = "workflow:{}".format(json.dumps(workflow))      # Make
    extras = cfg.get("meta_extra", []) or []
    desc = []
    for f in extras:
        k, v = str(f.get("key", "")).strip(), str(f.get("value", ""))
        if not k:
            continue
        desc.append(f"{k}: {v}")
        if k.lower() in ("artist", "author"):
            exif[0x013B] = v                                            # Artist
        if k.lower() == "copyright":
            exif[0x8298] = v                                            # Copyright
    if desc:
        exif[0x010E] = "\n".join(desc)                                  # ImageDescription
    return exif


# ---------------------------------------------------------------- tensors

def tensor_to_pil(image_tensor):
    arr = np.clip(255.0 * image_tensor.cpu().numpy(), 0, 255).astype(np.uint8)
    return Image.fromarray(arr)


def mask_to_pil(mask_tensor, invert=False):
    arr = np.clip(255.0 * mask_tensor.cpu().numpy(), 0, 255).astype(np.uint8)
    if invert:
        arr = 255 - arr
    return Image.fromarray(arr, mode="L")


# ---------------------------------------------------------------- saving

def _new_record(filename, subfolder, ftype, fmt, held, mask_ref, cfg=None,
                seed=None, model=None, wf=False, root=None):
    rec = {
        "id": uuidlib.uuid4().hex[:12],
        "ts": time.time(),
        "filename": filename,
        "subfolder": subfolder,
        "type": ftype,
        "format": fmt,
        "held": held,
        "mask": mask_ref,
        "seed": seed,
        "model": model or None,
        "starred": False,
        "wf": bool(wf),
    }
    if root:
        # Only stamped when a custom save_root is in effect — its absence
        # means "the normal ComfyUI directory for `type`", same as before.
        rec["root"] = root
    if cfg is not None:
        rec["cfg"] = cfg
    return rec


def apply_watermark(pil_img, cfg):
    """Composite the configured watermark PNG onto a copy of the image.
    Scale is a fraction of the image width; inset is hard pixels from the
    chosen edges. Returns the original image untouched on any failure."""
    ref = cfg.get("watermark_image")
    if not (cfg.get("watermark_enabled") and isinstance(ref, dict)
            and ref.get("filename")):
        return pil_img
    try:
        wm = Image.open(record_path(ref)).convert("RGBA")
    except Exception as e:
        print(f"[ImageSaveBling] watermark image unavailable ({e}) — skipping")
        return pil_img
    scale = min(1.0, max(0.01, float(cfg.get("watermark_scale", 0.15))))
    tw = max(1, round(pil_img.width * scale))
    th = max(1, round(wm.height * tw / wm.width))
    wm = wm.resize((tw, th), Image.LANCZOS)
    opacity = min(1.0, max(0.0, float(cfg.get("watermark_opacity", 1.0))))
    if opacity < 1.0:
        wm.putalpha(wm.getchannel("A").point(lambda v: round(v * opacity)))
    inset = max(0, int(cfg.get("watermark_inset", 24)))
    pos = str(cfg.get("watermark_position", "br"))
    v = pos[0] if len(pos) == 2 else "c"
    h = pos[1] if len(pos) == 2 else "c"
    x = {"l": inset, "c": (pil_img.width - tw) // 2,
         "r": pil_img.width - tw - inset}.get(h, inset)
    y = {"t": inset, "c": (pil_img.height - th) // 2,
         "b": pil_img.height - th - inset}.get(v, inset)
    out = pil_img.convert("RGBA")
    out.alpha_composite(wm, (max(0, min(x, out.width - 1)),
                             max(0, min(y, out.height - 1))))
    return out


def save_single(pil_img, cfg, prompt, workflow, ctx, mask_pil=None):
    """Write one image (plus optional mask companion and sidecar) to the
    output directory using the cfg naming/metadata rules. Returns a record."""
    pil_img = apply_watermark(pil_img, cfg)
    fmt = cfg.get("format", "png")
    if fmt not in _EXT:
        fmt = "png"
    dirpath, sub, root = resolve_dir(cfg, ctx)
    stem = resolve_stem(cfg, ctx, dirpath)
    fname = stem + _EXT[fmt]
    fpath = os.path.join(dirpath, fname)

    if fmt == "png":
        pil_img.save(fpath, pnginfo=_png_metadata(cfg, prompt, workflow),
                     compress_level=int(cfg.get("png_compress", 4)))
    elif fmt == "jpg":
        exif = _exif_metadata(pil_img, cfg, prompt, workflow)
        pil_img.convert("RGB").save(fpath, quality=int(cfg.get("quality", 90)),
                                    exif=exif.tobytes())
    else:  # webp
        exif = _exif_metadata(pil_img, cfg, prompt, workflow)
        pil_img.save(fpath, quality=int(cfg.get("quality", 90)),
                     lossless=bool(cfg.get("lossless_webp")), exif=exif.tobytes())

    if cfg.get("sidecar_json") and workflow is not None and not metadata_disabled():
        try:
            with open(os.path.join(dirpath, stem + ".json"), "w", encoding="utf-8") as f:
                json.dump(workflow, f)
        except OSError as e:
            print(f"[ImageSaveBling] sidecar write failed: {e}")

    mask_ref = None
    if mask_pil is not None:
        suffix = clean_filename(cfg.get("mask_suffix", "_mask") or "_mask")
        mask_name = stem + suffix + ".png"
        mask_pil.save(os.path.join(dirpath, mask_name), compress_level=4)
        mask_ref = {"filename": mask_name, "subfolder": sub, "type": "output"}
        if root:
            mask_ref["root"] = root

    seed = ctx.get("seed")
    wf_available = (workflow is not None and not metadata_disabled()
                    and (cfg.get("meta_workflow") or cfg.get("sidecar_json")))
    return _new_record(fname, sub, "output", fmt, False, mask_ref,
                       seed=None if seed == "" else seed,
                       model=ctx.get("model") or None, wf=wf_available, root=root)


def save_held(pil_img, cfg, prompt, workflow, mask_pil=None):
    """Park one image in the temp dir with full metadata embedded. The cfg
    active at generation time still rides along in the record as a
    fallback (an older frontend, or a record held before this existed),
    but commit_held() prefers whatever the panel's live settings are at
    commit time over this snapshot."""
    dirpath = os.path.join(folder_paths.get_temp_directory(), HELD_SUBFOLDER)
    os.makedirs(dirpath, exist_ok=True)
    hid = uuidlib.uuid4().hex[:12]
    fname = f"held_{hid}.png"
    pil_img.save(os.path.join(dirpath, fname),
                 pnginfo=_png_metadata(cfg, prompt, workflow, force_all=True),
                 compress_level=1)
    mask_ref = None
    if mask_pil is not None:
        mask_name = f"held_{hid}_mask.png"
        mask_pil.save(os.path.join(dirpath, mask_name), compress_level=1)
        mask_ref = {"filename": mask_name, "subfolder": HELD_SUBFOLDER, "type": "temp"}
    snapshot = {k: v for k, v in cfg.items() if k != "uuid"}
    seed, model = extract_prompt_info(prompt)
    rec = _new_record(fname, HELD_SUBFOLDER, "temp", "png", True, mask_ref,
                      cfg=snapshot, seed=seed, model=model,
                      wf=workflow is not None and not metadata_disabled())
    rec["id"] = hid
    return rec


def record_path(rec):
    # A "root" on the record means it was saved under a custom save_root
    # rather than one of ComfyUI's own directories.
    root = rec.get("root")
    if not root:
        t = rec.get("type", "output")
        root = {"temp": folder_paths.get_temp_directory(),
                "input": folder_paths.get_input_directory()}.get(
            t, folder_paths.get_output_directory())
    sub = rec.get("subfolder", "") or ""
    return os.path.join(root, *[p for p in sub.split("/") if p], rec["filename"])


def commit_held(rec, live_cfg=None):
    """Re-encode a held temp PNG into the output dir. Returns the
    replacement record. Temp files are removed on success.

    Uses `live_cfg` — the node's current panel settings, sent fresh by the
    frontend on every commit — when given, so format/naming/metadata/mask/
    watermark/save_root are all decided at commit time, not frozen back
    when the image was generated (that's the whole point of holding: you
    review, maybe adjust settings, then decide). Falls back to the cfg
    snapshot recorded at hold time (`rec["cfg"]`) only if no live config was
    sent — e.g. an older frontend, or a held record from before this."""
    cfg = dict(DEFAULTS)
    cfg.update((live_cfg if live_cfg is not None else rec.get("cfg", {})) or {})
    src = record_path(rec)
    img = Image.open(src)
    img.load()
    text = getattr(img, "text", {}) or {}
    prompt = workflow = None
    try:
        if "prompt" in text:
            prompt = json.loads(text["prompt"])
    except Exception:
        pass
    try:
        if "workflow" in text:
            workflow = json.loads(text["workflow"])
    except Exception:
        pass

    mask_pil = None
    mask_src = None
    if rec.get("mask"):
        mask_src = record_path(rec["mask"])
        if os.path.exists(mask_src):
            mask_pil = Image.open(mask_src).convert("L")
        else:
            mask_src = None

    ctx = build_ctx(cfg, prompt, img.width, img.height, 0)
    new_rec = save_single(img, cfg, prompt, workflow, ctx, mask_pil=mask_pil)
    new_rec["id"] = rec["id"]
    new_rec["starred"] = bool(rec.get("starred"))

    for p in (src, mask_src):
        if p:
            try:
                os.remove(p)
            except OSError:
                pass
    return new_rec


def save_to_input(rec, name):
    """Copy a recorded image into ComfyUI's input directory under the given
    name (extension enforced from the source; collisions auto-suffix).
    Returns the final filename."""
    import shutil
    src = record_path(rec)
    ext = os.path.splitext(rec["filename"])[1].lower() or ".png"
    name = clean_filename(name or os.path.splitext(rec["filename"])[0])
    root, typed_ext = os.path.splitext(name)
    # a typed image extension is replaced with the source's real one; anything
    # else (like a dot in "v1.2") stays part of the name
    stem = root if typed_ext.lower() in (".png", ".jpg", ".jpeg", ".webp") else name
    dest_dir = folder_paths.get_input_directory()
    os.makedirs(dest_dir, exist_ok=True)
    root = stem
    final = stem + ext
    n = 0
    while os.path.exists(os.path.join(dest_dir, final)):
        n += 1
        final = f"{root}_{n:04d}{ext}"
    shutil.copyfile(src, os.path.join(dest_dir, final))
    return final


def extract_workflow(rec):
    """The workflow JSON that produced a recorded image: PNG text chunk,
    EXIF Make tag (JPEG/WebP), or sidecar .json — whichever exists."""
    path = record_path(rec)
    try:
        img = Image.open(path)
        img.load()
        text = getattr(img, "text", {}) or {}
        if "workflow" in text:
            return json.loads(text["workflow"])
        v = img.getexif().get(0x010F)
        if isinstance(v, str) and v.startswith("workflow:"):
            return json.loads(v[len("workflow:"):])
    except Exception:
        pass
    try:
        with open(os.path.splitext(path)[0] + ".json", "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def discard_held(rec):
    for r in (rec, rec.get("mask")):
        if r:
            try:
                os.remove(record_path(r))
            except OSError:
                pass
