"""로그인 입력과 공개할 사용자 정보의 형식을 정의한다."""

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from app.security import normalize_username


class LoginRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)

    # 객체 출력 시 비밀번호가 가려지도록 일반 문자열 대신 SecretStr을 쓴다.
    password: SecretStr = Field(min_length=1, max_length=128)

    @field_validator("username", mode="before")
    @classmethod
    def normalize_login_username(cls, username: object) -> str:
        if not isinstance(username, str):
            raise ValueError("아이디는 문자열이어야 합니다.")

        return normalize_username(username)


class PublicUser(BaseModel):
    # DB 사용자 객체에서 아래 세 필드만 읽어 응답으로 변환한다.
    model_config = ConfigDict(from_attributes=True)

    id: int

    username: str

    display_name: str

    is_guest: bool = False


class AuthResponse(BaseModel):
    user: PublicUser

    # 클라이언트는 이 시간으로 로그인 만료 시점을 표시할 수 있다.
    expires_in: int = Field(ge=0)
