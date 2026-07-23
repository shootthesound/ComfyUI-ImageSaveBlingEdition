"""Image Save - Bling Edition — the node.

A save node with a fully custom DOM UI (see web/imagesavebling.js): session
gallery with recovery, PNG/JPEG/WebP, metadata control with credit templates,
filename/subfolder token patterns, overwrite control, optional mask
companions (piped in or auto person-mask) and a hold-for-review triage mode.

All settings arrive as one JSON blob in the hidden `config` widget, written
by the DOM panel.
"""

from . import bling_history, bling_saver


class ImageSaveBlingEdition:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "Images to save."}),
                "config": ("STRING", {"default": "{}", "multiline": False}),
            },
            "optional": {
                "masks": ("MASK", {"tooltip": "Optional masks saved beside each image "
                                              "(enable the Mask tab, source: from input)."}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "image"
    DESCRIPTION = ("Save node with a session gallery (browse everything saved this "
                   "session, recovered after reloads), PNG/JPEG/WebP with quality "
                   "control, full metadata control with credit templates, filename and "
                   "subfolder patterns, overwrite control, optional mask saved beside "
                   "each image, and a hold-for-review mode where you pick which images "
                   "to keep from the gallery.")

    def save(self, images, config, masks=None, prompt=None, extra_pnginfo=None,
             unique_id=None):
        cfg = bling_saver.merge_config(config)
        uid = cfg.get("uuid") or (str(unique_id) if unique_id is not None else "")
        workflow = (extra_pnginfo or {}).get("workflow")
        hold = cfg.get("mode") == "hold"

        mask_source = cfg.get("mask_source", "input")
        mask_mod = None
        if cfg.get("mask_enabled") and mask_source == "person":
            try:
                from . import bling_mask
                if bling_mask.available():
                    mask_mod = bling_mask
                else:
                    print("[ImageSaveBling] mediapipe not installed — auto mask skipped")
            except Exception as e:
                print(f"[ImageSaveBling] auto mask unavailable: {e}")

        records = []
        for i, image in enumerate(images):
            pil = bling_saver.tensor_to_pil(image)

            mask_pil = None
            if cfg.get("mask_enabled"):
                if mask_source == "input" and masks is not None:
                    m = masks[i] if i < masks.shape[0] else masks[-1]
                    mask_pil = bling_saver.mask_to_pil(m, invert=cfg.get("mask_invert"))
                elif mask_mod is not None:
                    try:
                        mask_pil = mask_mod.person_mask(
                            pil, cfg.get("mask_parts", ["face"]),
                            confidence=float(cfg.get("mask_confidence", 0.4)),
                            refine=bool(cfg.get("mask_refine", True)))
                        if cfg.get("mask_invert"):
                            from PIL import ImageOps
                            mask_pil = ImageOps.invert(mask_pil)
                    except Exception as e:
                        print(f"[ImageSaveBling] auto mask failed: {e}")

            if hold:
                rec = bling_saver.save_held(pil, cfg, prompt, workflow, mask_pil=mask_pil)
            else:
                ctx = bling_saver.build_ctx(cfg, prompt, pil.width, pil.height, i)
                rec = bling_saver.save_single(pil, cfg, prompt, workflow, ctx,
                                            mask_pil=mask_pil)
            records.append(rec)

        if uid:
            bling_history.append(uid, records)

        # Custom ui key only — the DOM gallery is the preview. Returning the
        # standard "images" key would make the frontend draw a duplicate
        # preview underneath the panel.
        return {"ui": {"bling": records}}


NODE_CLASS_MAPPINGS = {"ImageSaveBlingEdition": ImageSaveBlingEdition}
NODE_DISPLAY_NAME_MAPPINGS = {"ImageSaveBlingEdition": "Image Save - Bling Edition"}
