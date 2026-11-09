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
    instance = Database(tmp_path / "nested" / "accounts.sqlite3")
    instance.create_tables()
    yield instance
    instance.dispose()


def test_database_preserves_accounts_and_sessions_across_restart(tmp_path):
    path = tmp_path / "accounts.sqlite3"
    token = new_session_token()
    first = Database(path)
    first.create_tables()
    with first.session_factory() as session:
        user = User(username="  Minho ", display_name="박민호", password_hash="test-hash")
        session.add(user)
        session.flush()
        session.add(
            LoginSession(user_id=user.id, token_hash=hash_token(token), expires_at=2_000_000_000)
        )
        session.add(LoginAttempt(key="a" * 64, failures=2, window_start=1_900_000_000))
        session.commit()
        user_id = user.id
        assert user.is_active is True
        assert isinstance(user.created_at, int)
    first.dispose()

    reopened = Database(path)
    try:
        reopened.create_tables()
        with reopened.session_factory() as session:
            user = session.get(User, user_id)
            assert user.username == "minho"
            assert user.display_name == "박민호"
            assert session.scalar(select(LoginSession)).token_hash == hash_token(token)
            assert session.get(LoginAttempt, "a" * 64).failures == 2
        with sqlite3.connect(path) as connection:
            assert token not in "\n".join(connection.iterdump())
    finally:
        reopened.dispose()


def test_duplicate_username_is_rejected_after_normalization(database):
    with database.session_factory() as session:
        session.add(User(username="minho", display_name="민호", password_hash="first"))
        session.commit()
        session.add(User(username=" MINHO ", display_name="다른 사용자", password_hash="second"))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
        assert session.scalar(select(User)).password_hash == "first"


def test_foreign_keys_and_unique_session_tokens_are_enforced(database):
    with database.session_factory() as session:
        session.add(LoginSession(user_id=999, token_hash="a" * 64, expires_at=2_000_000_000))
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()
        user = User(username="minho", display_name="민호", password_hash="test")
        session.add(user)
        session.flush()
        session.add(LoginSession(user_id=user.id, token_hash="a" * 64, expires_at=2_000_000_000))
        session.commit()
        session.add(LoginSession(user_id=user.id, token_hash="a" * 64, expires_at=2_000_000_000))
        with pytest.raises(IntegrityError):
            session.commit()


def test_sqlite_pragmas_and_non_expiring_commits(database):
    with database.engine.connect() as connection:
        assert connection.scalar(text("PRAGMA foreign_keys")) == 1
        assert connection.scalar(text("PRAGMA busy_timeout")) == 5000
        assert connection.scalar(text("PRAGMA journal_mode")) == "wal"
    with database.session_factory() as session:
        assert session.expire_on_commit is False


def test_in_memory_database_is_shared_with_request_threads():
    database = Database(Path(":memory:"))
    try:
        database.create_tables()
        with database.session_factory() as session:
            session.add(User(username="minho", display_name="민호", password_hash="test"))
            session.commit()

        def read_username():
            with database.session_factory() as session:
                return session.scalar(select(User.username))

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
    password = "test-only-password!"
    first = hash_password(password)
    second = hash_password(password)
    assert first.startswith("$argon2id$")
    assert first != second
    assert password not in first
    assert verify_password(password, first)
    assert not verify_password("incorrect-password", first)


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
    first, second = new_session_token(), new_session_token()
    assert first != second
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", first)
    assert re.fullmatch(r"[a-f0-9]{64}", hash_token(first))
    assert hash_token(first) == hash_token(first)
    assert hash_token(first) != hash_token(second)


@pytest.fixture
def cli_setup(tmp_path, monkeypatch):
    path = tmp_path / "accounts.sqlite3"
    monkeypatch.setattr(cli, "Settings", lambda: SimpleNamespace(database_path=path))

    def provide_passwords(*values):
        responses = iter(values)
        monkeypatch.setattr(cli.getpass, "getpass", lambda _: next(responses))

    return path, provide_passwords


def test_cli_creates_normalized_account_without_printing_password(cli_setup, capsys):
    path, provide_passwords = cli_setup
    password = "test-only-password!"
    provide_passwords(password, password)
    assert cli.main(["create-user", "--username", "MINHO", "--display-name", "박민호"]) == 0
    output = capsys.readouterr()
    assert "minho" in output.out
    assert password not in output.out + output.err
    database = Database(path)
    try:
        with database.session_factory() as session:
            user = session.scalar(select(User))
            assert user.display_name == "박민호"
            assert verify_password(password, user.password_hash)
            assert user.password_hash not in output.out + output.err
    finally:
        database.dispose()


def test_cli_duplicate_keeps_existing_account(cli_setup, capsys):
    path, provide_passwords = cli_setup
    args = ["create-user", "--username", "minho", "--display-name", "박민호"]
    provide_passwords("test-only-original!", "test-only-original!")
    assert cli.main(args) == 0
    capsys.readouterr()
    provide_passwords("test-only-replacement!", "test-only-replacement!")
    assert cli.main(args) == 1
    assert "이미 존재" in capsys.readouterr().err
    database = Database(path)
    try:
        with database.session_factory() as session:
            password_hash = session.scalar(select(User)).password_hash
            assert verify_password("test-only-original!", password_hash)
    finally:
        database.dispose()


@pytest.mark.parametrize(
    "passwords,message",
    [(("short", "short"), "12~128"), (("test-only-password!", "different"), "일치")],
)
def test_cli_invalid_password_does_not_create_database(cli_setup, capsys, passwords, message):
    path, provide_passwords = cli_setup
    provide_passwords(*passwords)
    assert cli.main(["create-user", "--username", "minho", "--display-name", "박민호"]) == 1
    output = capsys.readouterr()
    assert message in output.err
    assert passwords[0] not in output.out + output.err
    assert not path.exists()


def test_cli_rejects_password_argument(capsys):
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
    output = capsys.readouterr()
    assert "대화형" in output.err
    assert "must-never-be-printed" not in output.out + output.err
