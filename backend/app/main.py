"""서버 설정, DB 연결, 공통 검사, 기능별 API를 연결한다."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.auth import router as auth_router
from app.api.datasets import router as datasets_router
from app.api.health import router as health_router
from app.api.models import router as models_router
from app.api.runs import router as runs_router
from app.config import Settings
from app.db import Database
from app.errors import register_error_handlers
from app.middleware import BrowserSecurityMiddleware, UploadSizeLimitMiddleware
from app.services.runs import RunManager


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings if settings is not None else Settings()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        # 서버가 시작될 때 DB를 열고, 종료될 때 연결을 정리한다.
        database = Database(settings.database_path)

        application.state.database = database

        run_manager: RunManager | None = None

        try:
            # 기존 테이블과 계정은 보존하고, 없는 테이블만 생성한다.
            database.create_tables()
            run_manager = RunManager(database, settings)

            # 완료한 결과는 보존하고, 강제 종료로 남은 실행 상태만 정리한다.
            run_manager.recover_interrupted()
            application.state.run_manager = run_manager

            yield
        finally:
            # 작업이 자기 DB 연결을 정리한 뒤 전체 DB 연결을 닫는다.
            if run_manager is not None:
                run_manager.shutdown()
            database.dispose()

    application = FastAPI(
        title=settings.app_name,
        version=__version__,
        description="꼬부기 백엔드 API",
        lifespan=lifespan,
    )

    # 라우터가 같은 설정과 DB를 사용하도록 앱에 보관한다.
    application.state.settings = settings

    register_error_handlers(application)

    # CORS를 바깥에 둬서 허용된 출처에는 오류 응답에도 CORS 헤더를 붙인다.
    application.add_middleware(
        UploadSizeLimitMiddleware, max_upload_bytes=settings.max_upload_bytes
    )
    application.add_middleware(
        BrowserSecurityMiddleware,
        trusted_origins=[*settings.cors_origins, *settings.trusted_origins],
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type", "X-Requested-With"],
    )

    application.include_router(health_router)
    application.include_router(auth_router)
    application.include_router(datasets_router)
    application.include_router(models_router)
    application.include_router(runs_router)
    return application


app = create_app()
