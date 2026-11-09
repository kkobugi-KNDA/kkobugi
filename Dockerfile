# syntax=docker/dockerfile:1
FROM node:24.22.1-bookworm-slim AS frontend-build
WORKDIR /build/frontend
RUN npm install --global pnpm@11.25.0
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY frontend/ ./
ENV VITE_API_BASE=/api/v1
RUN pnpm build

FROM ghcr.io/astral-sh/uv:0.12.23 AS uv
FROM python:3.12.15-slim-bookworm AS backend-build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_PYTHON_DOWNLOADS=never
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY backend/app/ ./app/
RUN uv sync --locked --no-dev --no-editable

FROM python:3.12.15-slim-bookworm AS runtime
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libgomp1 ca-certificates openssh-client gosu fonts-nanum \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --shell /bin/bash app \
    && usermod --unlock root \
    && mkdir -p /root/.ssh /home/app/.ssh /var/data /app/backend /app/frontend \
    && chmod 0700 /root/.ssh /home/app/.ssh \
    && chown -R app:app /home/app /app
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    KKOBUGI_ENVIRONMENT=production \
    KKOBUGI_COOKIE_SECURE=true \
    KKOBUGI_FRONTEND_DIST_PATH=/app/frontend/dist \
    KKOBUGI_DATABASE_PATH=/var/data/kkobugi/kkobugi.sqlite3 \
    KKOBUGI_DATASET_STORAGE_PATH=/var/data/kkobugi/datasets \
    KKOBUGI_MODEL_STORAGE_PATH=/var/data/kkobugi/models
WORKDIR /app/backend
COPY --from=backend-build /opt/venv /opt/venv
COPY --chown=app:app backend/app/ ./app/
COPY --from=frontend-build --chown=app:app /build/frontend/dist /app/frontend/dist
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/kkobugi-entrypoint
USER root
EXPOSE 10000
ENTRYPOINT ["kkobugi-entrypoint"]
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port \"${PORT:-10000}\" --workers 1"]
