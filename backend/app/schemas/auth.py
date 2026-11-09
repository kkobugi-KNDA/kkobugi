"""인증 요청에서 비밀번호를 숨기고 공개 사용자 정보만 응답한다."""

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator

from app.security import normalize_username


class LoginRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: SecretStr = Field(min_length=1, max_length=128)

    @field_validator("username", mode="before")
    @classmethod
    def normalized_username(cls, value: object) -> str:
        if not isinstance(value, str):
            raise ValueError("아이디는 문자열이어야 합니다.")
        return normalize_username(value)


class PublicUser(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    display_name: str


class AuthResponse(BaseModel):
    user: PublicUser
    expires_in: int = Field(ge=0)
