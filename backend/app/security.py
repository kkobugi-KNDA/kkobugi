"""비밀번호 및 세션 토큰 처리."""

import hashlib
import re
import secrets

from pwdlib import PasswordHash
from pwdlib.exceptions import UnknownHashError

_password_hash = PasswordHash.recommended()
_username_pattern = re.compile(r"[a-z0-9_.-]{3,64}", flags=re.ASCII)


def normalize_username(username: str) -> str:
    trimmed = username.strip()
    normalized = trimmed.lower()
    if not trimmed.isascii() or not _username_pattern.fullmatch(normalized):
        raise ValueError("아이디는 영문 소문자·숫자·밑줄·마침표·하이픈 3~64자로 입력하세요.")
    return normalized


def hash_password(password: str) -> str:
    if not 12 <= len(password) <= 128:
        raise ValueError("비밀번호는 12~128자로 입력하세요.")
    return _password_hash.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _password_hash.verify(password, password_hash)
    except (UnknownHashError, ValueError, TypeError):
        return False


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    # 원본 세션 토큰은 쿠키에만 담고 서버에는 일방향 해시를 저장한다.
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
