# Use Node.js 20 Alpine for smaller image size
FROM node:20-alpine

# Install system dependencies and Streamlink
RUN apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg \
    git \
    && pip3 install --break-system-packages --no-cache-dir streamlink \
    && git clone https://github.com/2bc4/streamlink-ttvlol.git /tmp/streamlink-ttvlol \
    && STREAMLINK_PLUGIN_DIR=$(python3 -c "import streamlink.plugins; import os; print(os.path.dirname(streamlink.plugins.__file__))") \
    && echo "=== Plugin Installation Debug ===" \
    && echo "Plugin directory: $STREAMLINK_PLUGIN_DIR" \
    && echo "Contents of ttvlol repo:" \
    && ls -la /tmp/streamlink-ttvlol/ \
    && echo "Original twitch.py size:" \
    && ls -lh $STREAMLINK_PLUGIN_DIR/twitch.py \
    && echo "New twitch.py size:" \
    && ls -lh /tmp/streamlink-ttvlol/twitch.py \
    && cp -f /tmp/streamlink-ttvlol/twitch.py $STREAMLINK_PLUGIN_DIR/twitch.py \
    && echo "Verifying installation:" \
    && ls -lh $STREAMLINK_PLUGIN_DIR/twitch.py \
    && echo "Checking for proxy-playlist in plugin:" \
    && grep -q "proxy-playlist" $STREAMLINK_PLUGIN_DIR/twitch.py && echo "✓ proxy-playlist found in plugin" || echo "✗ proxy-playlist NOT found" \
    && echo "Testing streamlink with --help:" \
    && streamlink --help | grep -i proxy || echo "No proxy option found in help" \
    && rm -rf /tmp/streamlink-ttvlol \
    && find /usr -name "*.pyc" -delete \
    && find /usr -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true

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
