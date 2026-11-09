"""DB에 해시만 저장하는 브라우저 세션과 계정별 로그인 제한."""

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
from app.models import LoginAttempt, LoginSession, User
from app.security import hash_password, hash_token, new_session_token, verify_password

_TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}")
# Generate once at startup so an unknown account still performs one password verification.
_DUMMY_PASSWORD_HASH = hash_password("kkobugi-dummy-password-8ed0f29b")


@dataclass(frozen=True, slots=True)
class AuthenticatedSession:
    user: User
    session: LoginSession
    expires_in: int


@dataclass(frozen=True, slots=True)
class LoginResult:
    user: User
    token: str = field(repr=False)
    expires_in: int


def _unauthenticated() -> HTTPException:
    return HTTPException(
        status_code=401,
        detail={"code": "UNAUTHENTICATED", "message": "다시 로그인해 주세요."},
    )


def _unavailable() -> HTTPException:
    return HTTPException(
        status_code=503,
        detail={
            "code": "AUTH_UNAVAILABLE",
            "message": "인증 처리를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.",
        },
    )


def _valid_token(token: str | None) -> bool:
    return isinstance(token, str) and _TOKEN_PATTERN.fullmatch(token) is not None


def _attempt_key(username: str, client_host: str) -> str:
    return hashlib.sha256(f"{username}\0{client_host}".encode()).hexdigest()


def _rate_limited(window_start: int, now: int, window_seconds: int) -> HTTPException:
    remaining = max(1, window_start + window_seconds - now)
    return HTTPException(
        status_code=429,
        detail={
            "code": "LOGIN_RATE_LIMITED",
            "message": "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        },
        headers={"Retry-After": str(remaining)},
    )


def _record_failure(db: Session, key: str, now: int, settings: Settings) -> None:
    # SQLite performs the increment while holding its write lock, including first insert races.
    expired = LoginAttempt.window_start <= now - settings.login_window_seconds
    # An expired bucket is reset in the same atomic UPSERT rather than by a read/modify/write.
    statement = insert(LoginAttempt).values(key=key, failures=1, window_start=now)
    statement = statement.on_conflict_do_update(
        index_elements=[LoginAttempt.key],
        set_={
            "failures": case((expired, 1), else_=LoginAttempt.failures + 1),
            "window_start": case((expired, now), else_=LoginAttempt.window_start),
        },
    ).returning(LoginAttempt.failures, LoginAttempt.window_start)
    try:
        failures, window_start = db.execute(statement).one()
        db.commit()
    except SQLAlchemyError:
        db.rollback()
        raise _unavailable() from None
    # Concurrent requests may have passed the initial check before another request hit the limit.
    if failures > settings.login_max_attempts:
        raise _rate_limited(window_start, now, settings.login_window_seconds)


def login(
    db: Session,
    *,
    username: str,
    password: str,
    client_host: str,
    current_token: str | None,
    settings: Settings,
) -> LoginResult:
    now = int(time.time())
    key = _attempt_key(username, client_host)
    attempt = db.get(LoginAttempt, key)
    if (
        attempt is not None
        and attempt.failures >= settings.login_max_attempts
        and attempt.window_start > now - settings.login_window_seconds
    ):
        raise _rate_limited(attempt.window_start, now, settings.login_window_seconds)

    user = db.scalar(select(User).where(User.username == username))
    password_hash = user.password_hash if user is not None else _DUMMY_PASSWORD_HASH
    password_matches = verify_password(password, password_hash)
    if user is None or not password_matches or not user.is_active:
        _record_failure(db, key, now, settings)
        raise HTTPException(
            status_code=401,
            detail={
                "code": "INVALID_CREDENTIALS",
                "message": "아이디 또는 비밀번호를 확인해 주세요.",
            },
        )

    for _ in range(3):
        token = new_session_token()
        try:
            db.execute(delete(LoginAttempt).where(LoginAttempt.key == key))
            if _valid_token(current_token):
                db.execute(
                    delete(LoginSession).where(LoginSession.token_hash == hash_token(current_token))
                )
            db.add(
                LoginSession(
                    user_id=user.id,
                    token_hash=hash_token(token),
                    created_at=now,
                    expires_at=now + settings.session_ttl_seconds,
                )
            )
            db.commit()
        except IntegrityError:
            # Retry a random-token uniqueness collision with a fresh transaction and token.
            db.rollback()
            continue
        except SQLAlchemyError:
            db.rollback()
            raise _unavailable() from None
        return LoginResult(user=user, token=token, expires_in=settings.session_ttl_seconds)
    raise _unavailable()


def get_authenticated_session(db: Session, token: str | None) -> AuthenticatedSession:
    if not _valid_token(token):
        raise _unauthenticated()
    stored_session = db.scalar(
        select(LoginSession).where(LoginSession.token_hash == hash_token(token))
    )
    if stored_session is None:
        raise _unauthenticated()

    now = int(time.time())
    user = db.get(User, stored_session.user_id)
    if stored_session.expires_at <= now or user is None or not user.is_active:
        db.delete(stored_session)
        try:
            db.commit()
        except SQLAlchemyError:
            # A failed cleanup must still reject this expired or disabled session with 401.
            db.rollback()
        raise _unauthenticated()
    return AuthenticatedSession(
        user=user,
        session=stored_session,
        expires_in=stored_session.expires_at - now,
    )


def logout(db: Session, token: str | None) -> None:
    if _valid_token(token):
        try:
            db.execute(delete(LoginSession).where(LoginSession.token_hash == hash_token(token)))
            db.commit()
        except SQLAlchemyError:
            db.rollback()
            raise _unavailable() from None
