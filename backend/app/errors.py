"""입력값과 비밀번호를 그대로 돌려주지 않는 공통 오류 응답."""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException


def register_error_handlers(application: FastAPI) -> None:
    @application.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
        error = exc.detail
        if not isinstance(error, dict) or "code" not in error or "message" not in error:
            error = {"code": "REQUEST_FAILED", "message": str(exc.detail)}
        return JSONResponse(
            status_code=exc.status_code, content={"error": error}, headers=exc.headers
        )

    @application.exception_handler(RequestValidationError)
    async def invalid_request(_: Request, exc: RequestValidationError) -> JSONResponse:
        fields = [
            {"field": list(error["loc"]), "message": error["msg"], "type": error["type"]}
            for error in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "입력한 항목을 확인해 주세요.",
                    "fields": fields,
                }
            },
        )
