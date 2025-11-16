#!/bin/bash

echo "🚀 Starting Streamlink Remote..."
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed!"
    echo "Please install Docker first: https://docs.docker.com/get-docker/"
    exit 1
fi

# Check if docker-compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo "❌ docker-compose is not installed!"
    echo "Please install docker-compose first: https://docs.docker.com/compose/install/"
    exit 1
fi

# Check if config has been edited
if grep -q "YOUR-NAS-IP" config/config.json; then
    echo "⚠️  WARNING: You need to edit config/config.json first!"
    echo ""
    echo "Please replace YOUR-NAS-IP with your actual NAS IP address."
    echo "Example: 192.168.1.100"
    echo ""
    read -p "Press Enter after you've edited the config, or Ctrl+C to cancel..."
fi

# Start docker-compose
echo "Starting Docker containers..."
docker-compose up -d

# Wait a moment
sleep 2

# Check status
if docker-compose ps | grep -q "Up"; then
    echo ""
    echo "✅ Streamlink Remote is running!"
    echo ""
    echo "📱 Access the web interface at:"

    # Try to detect local IP
    if command -v ip &> /dev/null; then
        LOCAL_IP=$(ip route get 1 | awk '{print $7;exit}')
        echo "   http://$LOCAL_IP:3000"
    else
        echo "   http://YOUR-IP-ADDRESS:3000"
    fi

    echo ""
    echo "📋 View logs with: docker-compose logs -f"
    echo "🛑 Stop with: docker-compose down"
    echo ""
else
    echo ""
    echo "❌ Failed to start!"
    echo "Check the logs with: docker-compose logs"
    exit 1
fi
