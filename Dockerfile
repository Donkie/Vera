FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/python/requirements.txt src/python/requirements.txt
RUN python3 -m venv .venv \
    && .venv/bin/python -m pip install --no-cache-dir -r src/python/requirements.txt

COPY src/ src/
RUN mkdir -p data models && chown node:node data models
USER node
ENV PYTHONUNBUFFERED=1

# Run npm start's launcher directly so it receives Docker's shutdown signal.
CMD ["node", "--env-file-if-exists=.env", "src/js/start.mjs"]
