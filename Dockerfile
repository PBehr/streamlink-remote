# Use Node.js 20 Alpine for smaller image size
FROM node:20-alpine

# Install system dependencies and Streamlink
RUN apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg \
    && pip3 install --break-system-packages --no-cache-dir streamlink

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --production

# Copy application files
COPY server/ ./server/
COPY config/ ./config/
COPY public/ ./public/

# Create data directory for SQLite database
RUN mkdir -p /app/data

# Expose ports
# API server port
EXPOSE 3000
# Streamlink HTTP server ports (configurable range)
EXPOSE 8080-8089

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/status', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Start the server
CMD ["node", "server/index.js"]
