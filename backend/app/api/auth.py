"""쿠키 기반 로그인, 현재 사용자 확인과 로그아웃 API."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User
from app.schemas.auth import AuthResponse, LoginRequest, PublicUser
from app.services import auth as auth_service

router = APIRouter(prefix="/api/v1/auth", tags=["인증"])
DbSession = Annotated[Session, Depends(get_db)]


def require_json_content_type(request: Request) -> None:
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type != "application/json":
        raise HTTPException(
            status_code=415,
            detail={
                "code": "UNSUPPORTED_MEDIA_TYPE",
                "message": "application/json 형식으로 요청해 주세요.",
            },
        )


def get_current_session(request: Request, db: DbSession) -> auth_service.AuthenticatedSession:
    cookie_name = request.app.state.settings.cookie_name
    return auth_service.get_authenticated_session(db, request.cookies.get(cookie_name))


CurrentSession = Annotated[auth_service.AuthenticatedSession, Depends(get_current_session)]


def get_current_user(current_session: CurrentSession) -> User:
    """보호할 API에서 Depends(get_current_user)로 재사용하는 인증 의존성."""
    return current_session.user


@router.post(
    "/login",
    response_model=AuthResponse,
    dependencies=[Depends(require_json_content_type)],
    summary="아이디와 비밀번호로 로그인",
)
def login(body: LoginRequest, request: Request, response: Response, db: DbSession) -> AuthResponse:
    settings = request.app.state.settings
    result = auth_service.login(
        db,
        username=body.username,
        password=body.password.get_secret_value(),
        client_host=request.client.host if request.client is not None else "unknown",
        current_token=request.cookies.get(settings.cookie_name),
        settings=settings,
    )
    response.set_cookie(
        key=settings.cookie_name,
        value=result.token,
        max_age=result.expires_in,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return AuthResponse(user=PublicUser.model_validate(result.user), expires_in=result.expires_in)


@router.get("/me", response_model=AuthResponse, summary="현재 로그인한 사용자 확인")
def me(current_session: CurrentSession) -> AuthResponse:
    return AuthResponse(
        user=PublicUser.model_validate(current_session.user),
        expires_in=current_session.expires_in,
    )


@router.post("/logout", status_code=204, response_class=Response, summary="현재 브라우저 로그아웃")
def logout(request: Request, db: DbSession) -> Response:
    settings = request.app.state.settings
    auth_service.logout(db, request.cookies.get(settings.cookie_name))
    response = Response(status_code=204)
    response.delete_cookie(
        key=settings.cookie_name,
        path="/",
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
    )
    return response
