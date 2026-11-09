"""API 오류 형식을 통일하고, 잘못된 입력값을 응답에 그대로 노출하지 않는다."""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException


def register_error_handlers(application: FastAPI) -> None:
    @application.exception_handler(HTTPException)
    async def http_error(_: Request, exception: HTTPException) -> JSONResponse:
        error_detail = exception.detail

        # 인증 서비스의 오류 형식과 프레임워크의 기본 오류 형식을 통일한다.
        if (
            not isinstance(error_detail, dict)
            or "code" not in error_detail
            or "message" not in error_detail
        ):
            error_detail = {"code": "REQUEST_FAILED", "message": str(exception.detail)}

        return JSONResponse(
            status_code=exception.status_code,
            content={"error": error_detail},
            headers=exception.headers,
        )

    @application.exception_handler(RequestValidationError)
    async def invalid_request(_: Request, exception: RequestValidationError) -> JSONResponse:
        # 검증 오류의 원본 input에는 비밀번호가 포함될 수 있어 필요한 설명만 남긴다.
        invalid_fields = [
            {"field": list(error["loc"]), "message": error["msg"], "type": error["type"]}
            for error in exception.errors()
        ]

        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "입력한 항목을 확인해 주세요.",
                    "fields": invalid_fields,
                }
            },
        )
