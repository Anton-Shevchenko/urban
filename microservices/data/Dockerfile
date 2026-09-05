# Python data service: OSM/GTFS pipeline + FastAPI city generator.
FROM python:3.12-slim AS build

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        g++ \
        libgeos-dev \
        libproj-dev \
        proj-data \
        proj-bin \
        gdal-bin \
        libgdal-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml README.md ./
COPY pipeline/ pipeline/
COPY server/ server/
RUN pip install .

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    DATA_DIR=/app/data \
    URBAN_ROOT=/app

# Shared geospatial libs only — compilers and *-dev headers stay in the builder.
RUN apt-get update && apt-get install -y --no-install-recommends \
        gdal-bin \
        proj-bin \
        proj-data \
    && (apt-get install -y --no-install-recommends libgeos-c1t64 \
        || apt-get install -y --no-install-recommends libgeos-c1v5) \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local /usr/local

WORKDIR /app
COPY scripts/ scripts/
COPY data/*.csv data/
RUN useradd --system --uid 1000 --home /app app \
    && mkdir -p data/cities data/gtfs data/zensus data/cache \
    && chown -R app:app /app

USER app
EXPOSE 8000

CMD ["python", "-m", "server"]
