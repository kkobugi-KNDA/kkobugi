"""비밀번호 및 세션 토큰 처리."""

import hashlib
import re
import secrets

from pwdlib import PasswordHash
from pwdlib.exceptions import UnknownHashError

# 해시 문자열이 아니라 비밀번호 해시를 생성·검증하는 도구다.
password_hasher = PasswordHash.recommended()

_username_pattern = re.compile(r"[a-z0-9_.-]{3,64}", flags=re.ASCII)


def normalize_username(username: str) -> str:
    trimmed_username = username.strip()

    normalized_username = trimmed_username.lower()

    # 소문자 변환 전에도 ASCII인지 확인해 비슷하게 보이는 다른 문자를 막는다.
    if not trimmed_username.isascii() or not _username_pattern.fullmatch(normalized_username):
        raise ValueError("아이디는 영문 소문자·숫자·밑줄·마침표·하이픈 3~64자로 입력하세요.")
    return normalized_username


def hash_password(password: str) -> str:
    if not 12 <= len(password) <= 128:
        raise ValueError("비밀번호는 12~128자로 입력하세요.")
    # Argon2id가 임의의 salt를 붙이므로 같은 비밀번호도 저장값은 달라진다.
    return password_hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return password_hasher.verify(password, password_hash)
    except (UnknownHashError, ValueError, TypeError):
        # 저장값이 손상돼도 인증에 성공하거나 내부 오류가 노출되지 않게 한다.
        return False


def new_session_token() -> str:
    # 추측하기 어려운 임의의 토큰을 발급하고 원본은 브라우저 쿠키에만 둔다.
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    # 원본 세션 토큰은 쿠키에만 담고 서버에는 일방향 해시를 저장한다.
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
