"""운영자가 대화형으로 사용자 계정을 만든다."""

import argparse
import getpass
import sys
from collections.abc import Sequence

from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.config import Settings
from app.db import Database
from app.models import User
from app.security import hash_password, normalize_username


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="꼬부기 사용자 관리")
    commands = parser.add_subparsers(dest="command", required=True)
    create_user = commands.add_parser("create-user", help="사용자 계정 생성")
    create_user.add_argument("--username", required=True)
    create_user.add_argument("--display-name", required=True)
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        # 잘못 전달한 비밀번호 인자가 오류 메시지로 다시 출력되지 않도록 한다.
        parser.error("지원하지 않는 인자입니다. 비밀번호는 대화형으로 입력하세요.")

    try:
        username = normalize_username(args.username)
        display_name = args.display_name.strip()
        if not 1 <= len(display_name) <= 80:
            raise ValueError("표시 이름은 1~80자로 입력하세요.")
        password = getpass.getpass("비밀번호 (12~128자): ")
        confirmation = getpass.getpass("비밀번호 확인: ")
        if password != confirmation:
            raise ValueError("비밀번호가 일치하지 않습니다.")
        password_hash = hash_password(password)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("사용자 생성을 취소했습니다.", file=sys.stderr)
        return 1

    database = Database(Settings().database_path)
    try:
        database.create_tables()
        with database.session_factory() as session:
            session.add(
                User(username=username, display_name=display_name, password_hash=password_hash)
            )
            session.commit()
    except IntegrityError:
        print("이미 존재하는 아이디입니다.", file=sys.stderr)
        return 1
    except SQLAlchemyError:
        # 데이터베이스 예외에는 해시 등 매개변수가 담길 수 있어 그대로 출력하지 않는다.
        print("데이터베이스에 사용자를 저장하지 못했습니다.", file=sys.stderr)
        return 1
    finally:
        database.dispose()

    print(f"사용자 '{username}'을 생성했습니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
