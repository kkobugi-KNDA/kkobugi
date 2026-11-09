"""배포된 프런트 파일과 페이지를 API와 같은 주소에서 제공한다."""

from pathlib import Path

from starlette.exceptions import HTTPException
from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

# React Router의 페이지에만 index.html을 돌려준다. 없는 API·파일은 404를 유지한다.
_PAGE_PATHS = {".", "", "data", "models", "review", "reports", "costs"}


class FrontendFiles(StaticFiles):
    def __init__(self, directory: Path):
        if not (directory / "index.html").is_file():
            raise RuntimeError("프런트 빌드 폴더에 index.html이 없습니다.")
        super().__init__(directory=directory, check_dir=True)

    async def get_response(self, path: str, scope: Scope) -> Response:
        normalized_path = path.replace("\\", "/").strip("/")
        segments = normalized_path.split("/")
        request_prefix = scope["path"].lstrip("/").split("/", 1)[0]
        if request_prefix == "api" or segments[0] == "api" or any(
            segment.startswith(".") and segment != "." for segment in segments
        ):
            raise HTTPException(status_code=404)
        if normalized_path in _PAGE_PATHS:
            response = await super().get_response("index.html", scope)
            response.headers["Cache-Control"] = "no-cache"
            return response
        return await super().get_response(path, scope)
