# Boardle (personal) — static app + profile/history API in one small container.
#   docker build -t boardle .
#   docker run -p 8000:8000 -v boardle-data:/data boardle                         # SQLite
#   docker run -p 8000:8000 -e BOARDLE_STORAGE=dynamodb -e BOARDLE_DDB_TABLE=boardle -e AWS_REGION=us-east-1 boardle
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    PORT=8000 BOARDLE_DB_PATH=/data/boardle.sqlite3 BOARDLE_COOKIE_SECURE=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd --system --uid 10001 boardle && mkdir -p /data && chown boardle /data
USER boardle
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/healthz')"
CMD ["python", "serve.py"]
