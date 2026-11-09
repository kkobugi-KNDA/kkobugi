"""계정의 모델 결과를 확인한 뒤 문헌·비용 설명을 저장한다."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.db import get_db
from app.models import User
from app.schemas.assistant import AssistantRequest, AssistantResponse
from app.services import assistant as assistant_service

router = APIRouter(prefix="/api/v1/assistant", tags=["점검 설명"])

DatabaseSession = Annotated[Session, Depends(get_db)]

CurrentUser = Annotated[User, Depends(get_current_user)]


@router.post("/messages", response_model=AssistantResponse, status_code=201)
def create_message(
    body: AssistantRequest,
    request: Request,
    database_session: DatabaseSession,
    current_user: CurrentUser,
) -> AssistantResponse:
    return assistant_service.create_message(
        database_session, current_user.id, request.app.state.settings, body
    )


@router.get("/messages/{message_id}", response_model=AssistantResponse)
def get_message(message_id: str, request: Request, current_user: CurrentUser) -> AssistantResponse:
    content = assistant_service.get_message(request.app.state.settings, current_user.id, message_id)

    return AssistantResponse.model_validate(content["response"])
