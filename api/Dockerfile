FROM python:3.12-slim
WORKDIR /srv
COPY pyproject.toml ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY benchmark ./benchmark
RUN pip install --no-cache-dir -e ".[dev]" \
    && useradd --system --uid 10001 elo \
    && mkdir -p /data && chown elo /data
ENV ELO_DATA_DIR=/data
USER elo
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/api/health')"
CMD ["python", "-m", "uvicorn", "elo.api:app_factory", "--factory", "--host", "0.0.0.0", "--port", "8000", "--app-dir", "src"]
