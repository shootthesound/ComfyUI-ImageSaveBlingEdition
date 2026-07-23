"""Optional automatic person masking for Image Save - Bling Edition.

Person-part segmentation via mediapipe's selfie_multiclass model (background,
hair, body, face, clothes), with an optional bbox-refine second pass.
mediapipe is a soft dependency: if it isn't installed the feature reports
unavailable and everything else keeps working.
"""

import os
from functools import reduce

import numpy as np
from PIL import Image

import folder_paths

# mediapipe class indices for selfie_multiclass_256x256
PARTS = {"background": 0, "hair": 1, "body": 2, "face": 3, "clothes": 4}


def available():
    import importlib.util
    return importlib.util.find_spec("mediapipe") is not None


def _model_path(name, url):
    model_folder = os.path.join(folder_paths.models_dir, "mediapipe")
    model_file = os.path.join(model_folder, name)
    if not os.path.exists(model_file):
        import urllib.request
        print(f"[ImageSaveBling] downloading {name}")
        os.makedirs(model_folder, exist_ok=True)
        urllib.request.urlretrieve(url, model_file)
    return model_file


def _segmenter_model_path():
    return _model_path(
        "selfie_multiclass_256x256.tflite",
        "https://storage.googleapis.com/mediapipe-models/image_segmenter/"
        "selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite")


def _bbox_padded(mask_image):
    gray = mask_image.convert("L")
    bbox = gray.point(lambda p: 255 if p > 0 else 0).getbbox()
    if bbox is None:
        return None
    left, upper, right, lower = bbox
    px = round((right - left) * 0.2)
    py = round((lower - upper) * 0.2)
    return (max(0, left - px), max(0, upper - py),
            min(gray.width, right + px), min(gray.height, lower + py))


def _segment_once(segmenter, mp, pil_rgba, part_ids, confidence):
    media_img = mp.Image(image_format=mp.ImageFormat.SRGBA, data=np.asarray(pil_rgba))
    result = segmenter.segment(media_img)
    h, w = pil_rgba.height, pil_rgba.width
    layers = []
    for pid in part_ids:
        m = result.confidence_masks[pid].numpy_view()
        if m.ndim == 3:
            m = m.max(axis=-1) if m.shape[-1] > 1 else m.squeeze(-1)
        layers.append((m > confidence).astype(np.uint8) * 255)
    if not layers:
        return Image.new("L", (w, h), 0)
    return Image.fromarray(reduce(np.maximum, layers), mode="L")


def person_mask(pil_img, parts, confidence=0.4, refine=True):
    """L-mode mask of the selected person parts for one PIL image."""
    import mediapipe as mp

    part_ids = [PARTS[p] for p in parts if p in PARTS]
    rgba = pil_img.convert("RGBA")

    with open(_segmenter_model_path(), "rb") as f:
        model_buffer = f.read()
    options = mp.tasks.vision.ImageSegmenterOptions(
        base_options=mp.tasks.BaseOptions(model_asset_buffer=model_buffer),
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
        output_category_mask=True,
    )
    with mp.tasks.vision.ImageSegmenter.create_from_options(options) as segmenter:
        mask = _segment_once(segmenter, mp, rgba, part_ids, confidence)
        if refine:
            bbox = _bbox_padded(mask)
            if bbox is not None:
                refined = _segment_once(segmenter, mp, rgba.crop(bbox), part_ids, confidence)
                mask = Image.new("L", rgba.size, 0)
                mask.paste(refined, bbox)
    return mask
