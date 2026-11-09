"""계정과 세션의 저장 규칙, 비밀번호 처리, 계정 생성 명령을 확인한다."""

import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from pwdlib import PasswordHash
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app import cli
from app.db import Database
from app.models import LoginAttempt, LoginSession, User
from app.security import (
    hash_password,
    hash_token,
    new_session_token,
    normalize_username,
    verify_password,
)


@pytest.fixture
def database(tmp_path):
    # 중첩 폴더 생성도 함께 확인하며 모든 파일은 pytest 임시 폴더에만 남긴다.
    test_database = Database(tmp_path / "nested" / "accounts.sqlite3")

    test_database.create_tables()
    yield test_database
    test_database.dispose()


def test_database_preserves_accounts_and_sessions_across_restart(tmp_path):
    # 연결을 완전히 닫고 같은 DB를 다시 열어 데이터가 메모리에만 남은 것은 아닌지 확인한다.
    database_path = tmp_path / "accounts.sqlite3"

    session_token = new_session_token()

    first_database = Database(database_path)

    first_database.create_tables()
    with first_database.session_factory() as database_session:
        user = User(username="  Minho ", display_name="박민호", password_hash="test-hash")

        database_session.add(user)
        database_session.flush()
        database_session.add(
            LoginSession(
                user_id=user.id, token_hash=hash_token(session_token), expires_at=2_000_000_000
            )
        )
        database_session.add(LoginAttempt(key="a" * 64, failures=2, window_start=1_900_000_000))
        database_session.commit()
        user_id = user.id

        assert user.is_active is True
        assert isinstance(user.created_at, int)
    first_database.dispose()

    reopened_database = Database(database_path)

    try:
        reopened_database.create_tables()
        with reopened_database.session_factory() as database_session:
            user = database_session.get(User, user_id)

            assert user.username == "minho"
            assert user.display_name == "박민호"
            assert database_session.scalar(select(LoginSession)).token_hash == hash_token(
                session_token
            )
            assert database_session.get(LoginAttempt, "a" * 64).failures == 2
        with sqlite3.connect(database_path) as connection:
            assert session_token not in "\n".join(connection.iterdump())
    finally:
        reopened_database.dispose()


def test_duplicate_username_is_rejected_after_normalization(database):
    # 공백과 대소문자가 달라도 같은 아이디이므로 기존 계정을 덮어쓰지 않아야 한다.
    with database.session_factory() as database_session:
        database_session.add(User(username="minho", display_name="민호", password_hash="first"))
        database_session.commit()
        database_session.add(
            User(username=" MINHO ", display_name="다른 사용자", password_hash="second")
        )
        with pytest.raises(IntegrityError):
            database_session.commit()
        database_session.rollback()
        assert database_session.scalar(select(User)).password_hash == "first"


def test_foreign_keys_and_unique_session_tokens_are_enforced(database):
    # 없는 사용자에게 세션을 발급하거나 같은 토큰 해시를 중복 저장하지 못하게 한다.
    with database.session_factory() as database_session:
        database_session.add(
            LoginSession(user_id=999, token_hash="a" * 64, expires_at=2_000_000_000)
        )
        with pytest.raises(IntegrityError):
            database_session.commit()
        database_session.rollback()
        user = User(username="minho", display_name="민호", password_hash="test")

        database_session.add(user)
        database_session.flush()
        database_session.add(
            LoginSession(user_id=user.id, token_hash="a" * 64, expires_at=2_000_000_000)
        )
        database_session.commit()
        database_session.add(
            LoginSession(user_id=user.id, token_hash="a" * 64, expires_at=2_000_000_000)
        )
        with pytest.raises(IntegrityError):
            database_session.commit()


def test_sqlite_pragmas_and_non_expiring_commits(database):
    with database.engine.connect() as connection:
        assert connection.scalar(text("PRAGMA foreign_keys")) == 1
        assert connection.scalar(text("PRAGMA busy_timeout")) == 5000
        assert connection.scalar(text("PRAGMA journal_mode")) == "wal"
    with database.session_factory() as database_session:
        assert database_session.expire_on_commit is False


def test_in_memory_database_is_shared_with_request_threads():
    # FastAPI 요청처럼 다른 스레드에서 읽어도 같은 메모리 DB에 접근해야 한다.
    database = Database(Path(":memory:"))

    try:
        database.create_tables()
        with database.session_factory() as database_session:
            database_session.add(User(username="minho", display_name="민호", password_hash="test"))
            database_session.commit()

        def read_username():
            with database.session_factory() as database_session:
                return database_session.scalar(select(User.username))

        with ThreadPoolExecutor(max_workers=1) as pool:
            assert pool.submit(read_username).result() == "minho"
    finally:
        database.dispose()


@pytest.mark.parametrize("username", ["ab", "a" * 65, "민호", "hello@user", "Kobugi", "a b"])
def test_username_rejects_non_ascii_or_invalid_characters(username):
    with pytest.raises(ValueError):
        normalize_username(username)


def test_username_normalizes_case_and_outer_whitespace():
    assert normalize_username("  Minho_1.Test-2  ") == "minho_1.test-2"


def test_argon2id_password_hashes_are_salted_and_verify():
    # 같은 비밀번호도 매번 다른 해시가 만들어지고 원문으로만 검증할 수 있어야 한다.
    password = "test-only-password!"

    first_hash = hash_password(password)

    second_hash = hash_password(password)

    assert first_hash.startswith("$argon2id$")
    assert first_hash != second_hash
    assert password not in first_hash
    assert verify_password(password, first_hash)
    assert not verify_password("incorrect-password", first_hash)


@pytest.mark.parametrize("password", ["short", "a" * 129])
def test_password_creation_enforces_length(password):
    with pytest.raises(ValueError, match="12~128"):
        hash_password(password)


def test_login_verification_accepts_legacy_short_passwords():
    legacy_hash = PasswordHash.recommended().hash("short")

    assert verify_password("short", legacy_hash)


@pytest.mark.parametrize("damaged_hash", ["", "invalid", "$argon2id$", "$argon2id$v=19$m=1$bad"])
def test_damaged_password_hash_returns_false(damaged_hash):
    assert not verify_password("test-only-password!", damaged_hash)


def test_session_tokens_have_entropy_and_only_hashes_are_stable():
    # 세션마다 새 토큰을 만들되 같은 토큰의 해시는 항상 같아야 DB에서 찾을 수 있다.
    first_token, second_token = new_session_token(), new_session_token()

    assert first_token != second_token
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", first_token)
    assert re.fullmatch(r"[a-f0-9]{64}", hash_token(first_token))
    assert hash_token(first_token) == hash_token(first_token)
    assert hash_token(first_token) != hash_token(second_token)


@pytest.fixture
def cli_setup(tmp_path, monkeypatch):
    # 실제 터미널 입력 대신 테스트용 비밀번호를 제공해 계정 생성 과정을 재현한다.
    database_path = tmp_path / "accounts.sqlite3"

    monkeypatch.setattr(cli, "Settings", lambda: SimpleNamespace(database_path=database_path))

    def provide_passwords(*values):
        password_inputs = iter(values)

        monkeypatch.setattr(cli.getpass, "getpass", lambda _: next(password_inputs))

    return database_path, provide_passwords


def test_cli_creates_normalized_account_without_printing_password(cli_setup, capsys):
    # 계정은 저장되지만 비밀번호와 해시는 명령 출력에 나타나지 않아야 한다.
    database_path, provide_passwords = cli_setup

    password = "test-only-password!"

    provide_passwords(password, password)
    assert cli.main(["create-user", "--username", "MINHO", "--display-name", "박민호"]) == 0
    command_output = capsys.readouterr()

    assert "minho" in command_output.out
    assert password not in command_output.out + command_output.err
    database = Database(database_path)

    try:
        with database.session_factory() as database_session:
            user = database_session.scalar(select(User))

            assert user.display_name == "박민호"
            assert verify_password(password, user.password_hash)
            assert user.password_hash not in command_output.out + command_output.err
    finally:
        database.dispose()


def test_cli_duplicate_keeps_existing_account(cli_setup, capsys):
    # 같은 아이디를 다시 만들려 해도 원래 비밀번호를 그대로 유지해야 한다.
    database_path, provide_passwords = cli_setup

    command_arguments = ["create-user", "--username", "minho", "--display-name", "박민호"]

    provide_passwords("test-only-original!", "test-only-original!")
    assert cli.main(command_arguments) == 0
    capsys.readouterr()
    provide_passwords("test-only-replacement!", "test-only-replacement!")
    assert cli.main(command_arguments) == 1
    assert "이미 존재" in capsys.readouterr().err
    database = Database(database_path)

    try:
        with database.session_factory() as database_session:
            password_hash = database_session.scalar(select(User)).password_hash

            assert verify_password("test-only-original!", password_hash)
    finally:
        database.dispose()


@pytest.mark.parametrize(
    "passwords,message",
    [(("short", "short"), "12~128"), (("test-only-password!", "different"), "일치")],
)
def test_cli_invalid_password_does_not_create_database(cli_setup, capsys, passwords, message):
    database_path, provide_passwords = cli_setup

    provide_passwords(*passwords)
    assert cli.main(["create-user", "--username", "minho", "--display-name", "박민호"]) == 1
    command_output = capsys.readouterr()

    assert message in command_output.err
    assert passwords[0] not in command_output.out + command_output.err
    assert not database_path.exists()


def test_cli_rejects_password_argument(capsys):
    # 비밀번호를 잘못 명령 인자로 넣어도 오류 출력이 그 값을 다시 노출하지 않아야 한다.
    with pytest.raises(SystemExit) as error:
        cli.main(
            [
                "create-user",
                "--username",
                "minho",
                "--display-name",
                "민호",
                "--password",
                "must-never-be-printed",
            ]
        )
    assert error.value.code == 2
    command_output = capsys.readouterr()

    assert "대화형" in command_output.err
    assert "must-never-be-printed" not in command_output.out + command_output.err
