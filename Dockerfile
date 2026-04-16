FROM node:20-slim

# Install Python and dependencies for faster-whisper
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Create Python venv and install faster-whisper
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir faster-whisper

WORKDIR /app

# Install Node dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/
COPY transcribe.py ./

# Build TypeScript
RUN npm run build

# Copy static files to dist
RUN cp -r src/public dist/public

ENV WHISPER_MODELS_DIR=/models
EXPOSE 3000

CMD ["node", "dist/server.js"]
