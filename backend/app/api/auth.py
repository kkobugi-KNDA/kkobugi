"""로그인·내 정보·로그아웃 요청을 서비스에 전달하고 쿠키를 관리한다."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.db import get_db
from app.memory_work import memory_guard
from app.models import User
from app.schemas.auth import AuthResponse, LoginRequest, PublicUser
from app.schemas.errors import ErrorResponse
from app.services import auth as auth_service

router = APIRouter(
    prefix="/api/v1/auth",
    tags=["인증"],
    responses={
        status_code: {"model": ErrorResponse} for status_code in (401, 403, 415, 422, 429, 503)
    },
)

# 요청마다 DB 연결을 받고, 요청이 끝나면 get_db가 연결을 반환한다.
DatabaseSession = Annotated[Session, Depends(get_db)]


def get_current_session(
    request: Request, database_session: DatabaseSession
) -> auth_service.AuthenticatedSession:
    cookie_name = request.app.state.settings.cookie_name

    return auth_service.get_authenticated_session(
        database_session, request.cookies.get(cookie_name)
    )


CurrentSession = Annotated[auth_service.AuthenticatedSession, Depends(get_current_session)]


def get_current_user(current_session: CurrentSession) -> User:
    """로그인이 필요한 API에 Depends(get_current_user)로 연결한다."""

    if current_session.user.is_guest:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "GUEST_READ_ONLY",
                "message": "관람 계정은 샘플 체험만 가능해요. 팀 데이터는 사용할 수 없어요.",
            },
        )
    return current_session.user


@router.post("/guest", response_model=AuthResponse, summary="관람용 샘플 체험 로그인")
def guest_login(
    request: Request, response: Response, database_session: DatabaseSession
) -> AuthResponse:
    settings = request.app.state.settings

    # 이미 로그인한 팀원과 관람자의 유효한 세션은 덮어쓰지 않는다.
    try:
        current = auth_service.get_authenticated_session(
            database_session, request.cookies.get(settings.cookie_name)
        )

        return AuthResponse(
            user=PublicUser.model_validate(current.user), expires_in=current.expires_in
        )
    except HTTPException as error:
        if error.status_code != 401:
            raise
    result = auth_service.guest_login(database_session)

    response.set_cookie(
        key=settings.cookie_name,
        value=result.session_token,
        max_age=result.expires_in,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return AuthResponse(user=PublicUser.model_validate(result.user), expires_in=result.expires_in)


@router.post(
    "/login",
    response_model=AuthResponse,
    summary="아이디와 비밀번호로 로그인",
    dependencies=[Depends(memory_guard)],
)
def login(
    credentials: LoginRequest,
    request: Request,
    response: Response,
    database_session: DatabaseSession,
) -> AuthResponse:
    settings = request.app.state.settings

    # 전달된 X-Forwarded-For 헤더를 직접 신뢰하지 않고 서버가 확인한 주소를 쓴다.
    client_ip = request.client.host if request.client is not None else "unknown"

    login_result = auth_service.login(
        database_session,
        username=credentials.username,
        password=credentials.password.get_secret_value(),
        client_ip=client_ip,
        previous_session_token=request.cookies.get(settings.cookie_name),
        settings=settings,
    )

    # 원본 토큰은 자바스크립트가 읽을 수 없는 쿠키에만 담는다.
    response.set_cookie(
        key=settings.cookie_name,
        value=login_result.session_token,
        max_age=login_result.expires_in,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )
    return AuthResponse(
        user=PublicUser.model_validate(login_result.user), expires_in=login_result.expires_in
    )


@router.get("/me", response_model=AuthResponse, summary="현재 로그인한 사용자 확인")
def me(current_session: CurrentSession) -> AuthResponse:
    # 비밀번호 해시와 세션 토큰은 응답 스키마에 포함하지 않는다.
    return AuthResponse(
        user=PublicUser.model_validate(current_session.user),
        expires_in=current_session.expires_in,
    )


@router.post("/logout", status_code=204, response_class=Response, summary="현재 브라우저 로그아웃")
def logout(request: Request, database_session: DatabaseSession) -> Response:
    settings = request.app.state.settings

    # DB의 세션을 먼저 지운 뒤 같은 이름·경로의 브라우저 쿠키를 해제한다.
    auth_service.logout(database_session, request.cookies.get(settings.cookie_name))

    response = Response(status_code=204)

    response.delete_cookie(
        key=settings.cookie_name,
        path="/",
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
    )
    return response
