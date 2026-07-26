# Deprecated: use Dockerfile.api + docker-compose.yml (api + frontend).
# Kept for one-off API-only builds.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        libgeos-dev \
        libproj-dev \
        proj-data \
        proj-bin \
        gdal-bin \
        libgdal-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pipeline/requirements.txt pipeline/requirements.txt
COPY server/requirements.txt server/requirements.txt
RUN pip install -r pipeline/requirements.txt -r server/requirements.txt

COPY pipeline/ pipeline/
COPY server/ server/
COPY data/ data/

EXPOSE 8000

CMD ["uvicorn", "server.app:app", "--host", "0.0.0.0", "--port", "8000"]
