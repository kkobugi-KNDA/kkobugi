"""브라우저 요청의 출처를 검사하고 인증 응답이 캐시에 남지 않게 한다."""

from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException
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

        is_private_request = request_path.startswith(
            (
                "/api/v1/auth",
                "/api/v1/datasets",
                "/api/v1/models",
                "/api/v1/runs",
                "/api/v1/observations",
                "/api/v1/reviews",
            )
        )

        async def send_without_private_cache(message: Message) -> None:
            # 계정과 CSV 응답은 성공·실패 모두 브라우저나 프록시에 저장하지 않는다.
            if is_private_request and message["type"] == "http.response.start":
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
            await self.app(scope, receive, send_without_private_cache)
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

            await error_response(scope, receive, send_without_private_cache)
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

                await error_response(scope, receive, send_without_private_cache)
                return

        await self.app(scope, receive, send_without_private_cache)


class UploadSizeLimitMiddleware:
    """파일을 모두 수신하기 전에도 요청 전체의 크기를 제한한다."""

    def __init__(self, app: ASGIApp, max_upload_bytes: int):
        self.app = app

        # multipart 경계·파일 이름·네 가지 설정값을 위한 여유 크기다.
        self.max_request_bytes = max_upload_bytes + 1024 * 1024

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope["path"] != "/api/v1/datasets"
            or scope["method"] != "POST"
        ):
            await self.app(scope, receive, send)
            return

        received_bytes = 0

        async def receive_limited_body() -> Message:
            nonlocal received_bytes

            message = await receive()

            if message["type"] == "http.request":
                received_bytes += len(message.get("body", b""))

                # Content-Length가 없거나 잘못된 값이어도 실제 받은 바이트로 판단한다.
                if received_bytes > self.max_request_bytes:
                    raise HTTPException(
                        status_code=413,
                        detail={
                            "code": "DATASET_TOO_LARGE",
                            "message": "업로드 요청이 허용된 크기를 넘었습니다.",
                        },
                    )

            return message

        # 파싱 중 예외가 발생하면 Starlette가 임시 업로드 파일도 닫는다.
        await self.app(scope, receive_limited_body, send)
