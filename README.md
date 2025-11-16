# Streamlink Remote

A web-based remote control for Streamlink that allows you to watch Twitch streams via HTTP from any device on your network.

## Features

- Web Interface: Control Streamlink from any device
- Twitch Integration: OAuth login, followed channels, live streams, search
- Stream Management: Start/stop streams, view active streams
- Real-time Updates: WebSocket for live status updates
- Remote Viewing: Streams accessible via HTTP (VLC, mpv, any media player)
- Ad-Free: Uses Twitch proxy playlist for ad-blocking
- Manual Authentication: Support for NAS deployment without OAuth

## Quick Start with Docker

1. Clone repository
2. Copy .env.example to .env
3. Run: docker-compose up -d
4. Open browser: http://localhost:3000
5. Login with Twitch

## Configuration

All settings configurable via environment variables or config/config.json.
See .env.example for all available options.

### Port Configuration

Default ports:
- Web interface: 3000
- Stream ports: 8080-8089

Change ports by editing .env file.

## NAS Deployment (Manual Token)

1. Run on PC and login
2. Go to: http://localhost:3000/api/auth/export-token
3. Copy token JSON
4. Add to NAS .env file (see MANUAL_AUTH_* variables in .env.example)
5. Deploy to NAS with docker-compose

## API Endpoints

- GET /api/status - Server status
- GET /api/auth/status - Auth status  
- GET /api/auth/export-token - Export token for manual auth
- GET /api/channels/followed - Followed channels
- GET /api/streams/live - Live streams
- POST /api/stream/start - Start stream
- POST /api/stream/stop - Stop stream
- GET /api/stream/active - Active streams

## Troubleshooting

### Cannot Access from Network
- Check firewall allows ports 3000 and 8080-8089
- Verify server binds to 0.0.0.0
- Use correct IP address (not 169.254.x.x)

### Streamlink Not Found
- Verify: streamlink --version
- Set STREAMLINK_EXECUTABLE to full path

### OAuth Redirect Error
- Use localhost for OAuth on PC
- For network/NAS: use manual token authentication

## License

MIT
