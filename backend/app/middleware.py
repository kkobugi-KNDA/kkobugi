"""브라우저 요청의 출처를 검사하고 인증 응답이 캐시에 남지 않게 한다."""

from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


class BrowserSecurityMiddleware:
    def __init__(self, app: ASGIApp, trusted_origins: list[str]):
        self.app = app

        self.trusted_origins = set(trusted_origins)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # 웹소켓 등 HTTP가 아닌 연결은 이 검사를 거치지 않는다.
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_path = scope["path"]

        is_auth_request = request_path == "/api/v1/auth" or request_path.startswith("/api/v1/auth/")

        async def send_without_auth_cache(message: Message) -> None:
            # 성공·실패 모두 인증 응답을 브라우저나 프록시에 저장하지 않는다.
            if is_auth_request and message["type"] == "http.response.start":
                response_headers = MutableHeaders(scope=message)

                response_headers["Cache-Control"] = "no-store"

            await send(message)

        is_write_request = request_path.startswith("/api/") and scope["method"] not in {
            "GET",
            "HEAD",
            "OPTIONS",
        }

        # 조회와 CORS 사전 확인 요청은 변경 요청 검사 없이 다음 단계로 넘긴다.
        if not is_write_request:
            await self.app(scope, receive, send_without_auth_cache)
            return

        request_headers = Headers(scope=scope)

        # CORS 설정만으로는 다른 사이트의 변경 요청을 막을 수 없어 두 값을 함께 확인한다.
        if (
            request_headers.get("origin") not in self.trusted_origins
            or request_headers.get("x-requested-with") != "kkobugi-web"
        ):
            error_response = JSONResponse(
                status_code=403,
                content={
                    "error": {
                        "code": "UNTRUSTED_REQUEST",
                        "message": "허용된 화면에서 다시 요청해 주세요.",
                    }
                },
            )

            await error_response(scope, receive, send_without_auth_cache)
            return

        # JSON 형식 검사는 여기 한 곳에서, 본문을 해석하기 전에 처리한다.
        if request_path == "/api/v1/auth/login":
            content_type = request_headers.get("content-type", "").split(";", 1)[0].strip().lower()

            if content_type != "application/json":
                error_response = JSONResponse(
                    status_code=415,
                    content={
                        "error": {
                            "code": "UNSUPPORTED_MEDIA_TYPE",
                            "message": "application/json 형식으로 요청해 주세요.",
                        }
                    },
                )

                await error_response(scope, receive, send_without_auth_cache)
                return

        await self.app(scope, receive, send_without_auth_cache)
