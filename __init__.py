from .image_save_bling import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from . import bling_history  # noqa: F401  (registers the /imagesavebling/* routes)

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
