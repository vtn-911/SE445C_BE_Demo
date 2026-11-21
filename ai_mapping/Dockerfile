FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY ai_mapping/requirements.txt ./ai_mapping/requirements.txt
RUN python -m pip install --no-cache-dir -r ai_mapping/requirements.txt

COPY ai_mapping/*.py ./ai_mapping/

EXPOSE 3400

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3400/health', timeout=2).read()"]

CMD ["python", "-m", "uvicorn", "ai_mapping.app:app", "--host", "0.0.0.0", "--port", "3400"]
