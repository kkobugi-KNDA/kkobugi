"""로그인 확인, 세션 저장, 로그인 실패 횟수 제한."""

import hashlib
import re
import time
from dataclasses import dataclass, field

from fastapi import HTTPException
from sqlalchemy import case, delete, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import GUEST_USERNAME, LoginAttempt, LoginSession, User
from app.security import hash_password, hash_token, new_session_token, verify_password

_SESSION_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}")

# 없는 아이디도 비밀번호 검사를 거쳐, 응답 속도로 계정 존재 여부가 드러나지 않게 한다.
_DUMMY_PASSWORD_HASH = hash_password("kkobugi-dummy-password-8ed0f29b")


@dataclass(frozen=True, slots=True)
class AuthenticatedSession:
    """세션 검증을 통과한 사용자와 남은 유효 시간."""

    user: User

    session: LoginSession

    expires_in: int


@dataclass(frozen=True, slots=True)
class LoginResult:
    """라우터가 사용자 응답과 쿠키를 만드는 데 필요한 로그인 결과."""

    user: User

    # 객체가 로그에 출력돼도 원본 토큰은 표시하지 않는다.
    session_token: str = field(repr=False)

    expires_in: int


def _authentication_required() -> HTTPException:
    return HTTPException(
        status_code=401,
        detail={"code": "UNAUTHENTICATED", "message": "다시 로그인해 주세요."},
    )


def _authentication_unavailable() -> HTTPException:
    # DB 오류의 원문에는 비밀번호 해시나 쿼리 인자가 포함될 수 있다.
    return HTTPException(
        status_code=503,
        detail={
            "code": "AUTH_UNAVAILABLE",
            "message": "인증 처리를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.",
        },
    )


def _is_valid_session_token(session_token: str | None) -> bool:
    return (
        isinstance(session_token, str)
        and _SESSION_TOKEN_PATTERN.fullmatch(session_token) is not None
    )


def _login_attempt_key(username: str, client_ip: str) -> str:
    # 같은 사무실 IP를 쓰는 다른 계정의 로그인을 함께 막지 않는다.
    return hashlib.sha256(f"{username}\0{client_ip}".encode()).hexdigest()


def _login_limit_error(window_start: int, current_time: int, window_seconds: int) -> HTTPException:
    retry_after = max(1, window_start + window_seconds - current_time)

    return HTTPException(
        status_code=429,
        detail={
            "code": "LOGIN_RATE_LIMITED",
            "message": "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        },
        headers={"Retry-After": str(retry_after)},
    )


def _record_failed_login(
    database_session: Session, attempt_key: str, current_time: int, settings: Settings
) -> None:
    # 제한 시간이 지난 기록은 실패 횟수를 1부터 다시 센다.
    window_expired = LoginAttempt.window_start <= current_time - settings.login_window_seconds

    statement = insert(LoginAttempt).values(key=attempt_key, failures=1, window_start=current_time)

    # 여러 요청이 동시에 실패해도 횟수가 누락되지 않도록 DB에서 한 번에 증가시킨다.
    statement = statement.on_conflict_do_update(
        index_elements=[LoginAttempt.key],
        set_={
            "failures": case((window_expired, 1), else_=LoginAttempt.failures + 1),
            "window_start": case((window_expired, current_time), else_=LoginAttempt.window_start),
        },
    ).returning(LoginAttempt.failures, LoginAttempt.window_start)

    try:
        failure_count, window_start = database_session.execute(statement).one()

        database_session.commit()
    except SQLAlchemyError:
        database_session.rollback()
        raise _authentication_unavailable() from None

    # 동시 요청이 사전 검사를 통과했더라도, 실제 누적 횟수로 다시 제한한다.
    if failure_count > settings.login_max_attempts:
        raise _login_limit_error(window_start, current_time, settings.login_window_seconds)


def login(
    database_session: Session,
    *,
    username: str,
    password: str,
    client_ip: str,
    previous_session_token: str | None,
    settings: Settings,
) -> LoginResult:
    current_time = int(time.time())

    attempt_key = _login_attempt_key(username, client_ip)

    login_attempt = database_session.get(LoginAttempt, attempt_key)

    # 비밀번호 검사 전에 이 계정과 IP의 로그인 제한부터 확인한다.
    if (
        login_attempt is not None
        and login_attempt.failures >= settings.login_max_attempts
        and login_attempt.window_start > current_time - settings.login_window_seconds
    ):
        raise _login_limit_error(
            login_attempt.window_start, current_time, settings.login_window_seconds
        )

    user = database_session.scalar(select(User).where(User.username == username))

    password_hash = user.password_hash if user is not None else _DUMMY_PASSWORD_HASH

    password_matches = verify_password(password, password_hash)

    # 없는 계정, 잘못된 비밀번호, 비활성 계정은 같은 오류를 반환한다.
    if user is None or not password_matches or not user.is_active or user.is_guest:
        _record_failed_login(database_session, attempt_key, current_time, settings)
        raise HTTPException(
            status_code=401,
            detail={
                "code": "INVALID_CREDENTIALS",
                "message": "아이디 또는 비밀번호를 확인해 주세요.",
            },
        )

    # 무작위 토큰이 기존 토큰과 겹치면 새 토큰으로 최대 세 번 시도한다.
    for _ in range(3):
        session_token = new_session_token()

        try:
            database_session.execute(delete(LoginAttempt).where(LoginAttempt.key == attempt_key))

            # 현재 브라우저의 이전 세션만 교체하고, 다른 브라우저 세션은 유지한다.
            if _is_valid_session_token(previous_session_token):
                database_session.execute(
                    delete(LoginSession).where(
                        LoginSession.token_hash == hash_token(previous_session_token)
                    )
                )

            database_session.add(
                LoginSession(
                    user_id=user.id,
                    token_hash=hash_token(session_token),
                    created_at=current_time,
                    expires_at=current_time + settings.session_ttl_seconds,
                )
            )
            database_session.commit()
        except IntegrityError:
            database_session.rollback()
            continue
        except SQLAlchemyError:
            database_session.rollback()
            raise _authentication_unavailable() from None

        return LoginResult(
            user=user, session_token=session_token, expires_in=settings.session_ttl_seconds
        )

    raise _authentication_unavailable()


def guest_login(database_session: Session) -> LoginResult:
    """공개 비밀번호 없이 관람 전용 세션을 발급한다. 팀 데이터 API는 별도로 거부한다."""
    current_time = int(time.time())

    expires_in = 2 * 60 * 60

    try:
        user = database_session.scalar(select(User).where(User.username == GUEST_USERNAME))

        if user is None:
            user = User(
                username=GUEST_USERNAME,
                display_name="관람자",
                password_hash=hash_password(new_session_token()),
            )

            database_session.add(user)
            try:
                database_session.commit()
            except IntegrityError:
                # 여러 QR 접속이 동시에 들어와도 예약 계정은 하나만 만든다.
                database_session.rollback()
                user = database_session.scalar(select(User).where(User.username == GUEST_USERNAME))
        if user is None or not user.is_active:
            raise _authentication_required()
        session_token = new_session_token()

        database_session.execute(
            delete(LoginSession).where(
                LoginSession.user_id == user.id, LoginSession.expires_at <= current_time
            )
        )
        database_session.add(
            LoginSession(
                user_id=user.id,
                token_hash=hash_token(session_token),
                created_at=current_time,
                expires_at=current_time + expires_in,
            )
        )
        database_session.commit()
        return LoginResult(user=user, session_token=session_token, expires_in=expires_in)
    except SQLAlchemyError:
        database_session.rollback()
        raise _authentication_unavailable() from None


def get_authenticated_session(
    database_session: Session, session_token: str | None
) -> AuthenticatedSession:
    if not _is_valid_session_token(session_token):
        raise _authentication_required()

    # 쿠키의 원본 토큰을 해시로 바꿔 DB에 저장된 세션과 비교한다.
    stored_session = database_session.scalar(
        select(LoginSession).where(LoginSession.token_hash == hash_token(session_token))
    )

    if stored_session is None:
        raise _authentication_required()

    current_time = int(time.time())

    user = database_session.get(User, stored_session.user_id)

    # 브라우저 쿠키가 남아 있어도 서버의 만료 시간과 계정 상태를 기준으로 거부한다.
    if stored_session.expires_at <= current_time or user is None or not user.is_active:
        database_session.delete(stored_session)
        try:
            database_session.commit()
        except SQLAlchemyError:
            # 만료 기록을 지우지 못해도 인증을 허용하지는 않는다.
            database_session.rollback()

        raise _authentication_required()

    return AuthenticatedSession(
        user=user,
        session=stored_session,
        expires_in=stored_session.expires_at - current_time,
    )


def logout(database_session: Session, session_token: str | None) -> None:
    # 세션이 없는 상태에서도 로그아웃은 성공한다.
    if not _is_valid_session_token(session_token):
        return

    try:
        database_session.execute(
            delete(LoginSession).where(LoginSession.token_hash == hash_token(session_token))
        )
        database_session.commit()
    except SQLAlchemyError:
        database_session.rollback()
        raise _authentication_unavailable() from None
