FROM node:20-bookworm-slim

# Install system dependencies required for canvas, OCR and PDF rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy root package files and install backend dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy frontend package files and install frontend dependencies
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install --omit=dev

# Copy all source code
WORKDIR /app
COPY . .

# Build Next.js production bundle
WORKDIR /app/frontend
RUN npm run build

# Return to app root
WORKDIR /app

# Railway passes PORT environment variable (defaults to 3000)
ENV PORT=3000
ENV BACKEND_PORT=3002
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "start-production.js"]
