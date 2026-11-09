"""브라우저의 변경 요청 출처를 검사하고 인증 응답 캐시를 막는다."""

from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class BrowserSecurityMiddleware:
    def __init__(self, app: ASGIApp, trusted_origins: list[str]):
        self.app = app
        self.trusted_origins = set(trusted_origins)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope["path"]
        is_auth = path == "/api/v1/auth" or path.startswith("/api/v1/auth/")

        async def send_private(message: Message) -> None:
            if is_auth and message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["Cache-Control"] = "no-store"
            await send(message)

        if path.startswith("/api/") and scope["method"] not in {"GET", "HEAD", "OPTIONS"}:
            headers = Headers(scope=scope)
            if (
                headers.get("origin") not in self.trusted_origins
                or headers.get("x-requested-with") != "kkobugi-web"
            ):
                response = JSONResponse(
                    status_code=403,
                    content={
                        "error": {
                            "code": "UNTRUSTED_REQUEST",
                            "message": "허용된 화면에서 다시 요청해 주세요.",
                        }
                    },
                )
                await response(scope, receive, send_private)
                return

            if path == "/api/v1/auth/login":
                media_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
                if media_type != "application/json":
                    response = JSONResponse(
                        status_code=415,
                        content={
                            "error": {
                                "code": "UNSUPPORTED_MEDIA_TYPE",
                                "message": "application/json 형식으로 요청해 주세요.",
                            }
                        },
                    )
                    await response(scope, receive, send_private)
                    return

        await self.app(scope, receive, send_private)
