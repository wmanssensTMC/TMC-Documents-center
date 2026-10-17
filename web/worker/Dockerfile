# TMC Document Center worker: Node (job handling) + Python 3.11 (the engine) + LibreOffice
# (Word -> PDF) + Tesseract/Ghostscript (OCR). Build from the repository root:
#   docker build -f web/worker/Dockerfile .
# Railway uses this file (railway.json); Azure Container Apps can use the same image later.
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-venv ca-certificates \
      libreoffice-writer-nogui fonts-dejavu-core fonts-liberation \
      tesseract-ocr ghostscript poppler-utils tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Engine dependencies (cached unless requirements.txt changes)
COPY engine/requirements.txt engine/requirements.txt
RUN python3 -m venv /opt/engine \
 && /opt/engine/bin/pip install --no-cache-dir -r engine/requirements.txt
ENV ENGINE_PYTHON=/opt/engine/bin/python \
    ENGINE_DIR=/app/engine

# Worker dependencies (cached unless package-lock.json changes)
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Code: the engine unchanged, plus the shared app library and the worker
COPY engine/ engine/
COPY web/lib/ web/lib/
COPY web/worker/ web/worker/
COPY web/tsconfig.json web/

# Run as a normal user, never as root. The code stays owned by root, so the worker (and the
# engine it starts) can read it but not change it; only temp folders are writable.
USER node
WORKDIR /app/web
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
# tini stops and cleans up child processes (LibreOffice, OCR) properly.
# react-server lets lib/* (marked "server-only") load outside Next.js.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--conditions=react-server", "--import", "tsx", "worker/main.ts"]
