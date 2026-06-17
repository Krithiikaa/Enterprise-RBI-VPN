# Precision RBI — ml-engine  [SRV-04]
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY scorer.py main.py ./
COPY blocklists ./blocklists
EXPOSE 8001
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD python -c "import urllib.request,sys; urllib.request.urlopen('http://localhost:8001/health'); sys.exit(0)"
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
