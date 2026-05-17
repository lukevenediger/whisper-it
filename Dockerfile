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

ARG COMMIT_HASH=dev
ENV WHISPER_COMMIT=$COMMIT_HASH
ENV WHISPER_MODELS_DIR=/models
ENV WHISPER_DATA_DIR=/data
ENV PORT=4000
# Cap CPU threads to keep peak memory bounded (ctranslate2 allocates per-thread scratch buffers)
ENV WHISPER_CPU_THREADS=2
ENV WHISPER_NUM_WORKERS=1
ENV OMP_NUM_THREADS=2
ENV MKL_NUM_THREADS=2
ENV OPENBLAS_NUM_THREADS=2
RUN mkdir -p /data
EXPOSE 4000

CMD ["node", "dist/server.js"]
