FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
RUN pip install --no-cache-dir -e ".[dev]"
# Placeholder until the HTTP API exists: keeps the container up so tools can be run from its console.
CMD ["sleep", "infinity"]
