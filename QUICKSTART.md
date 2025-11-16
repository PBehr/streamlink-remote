# 🚀 Quick Start Guide

## 1️⃣ Setup (5 minutes)

### On your NAS:

```bash
# Navigate to your apps directory
cd /volume1/docker/  # Synology example

# Copy the streamlink-remote folder here
# (You can use File Station or SFTP)

# Go into the directory
cd streamlink-remote

# IMPORTANT: Edit config with your NAS IP
nano config/config.json
# Change "redirectUri": "http://YOUR-NAS-IP:3000/auth/callback"
# Replace YOUR-NAS-IP with your actual NAS IP (e.g., 192.168.1.100)

# Start the container
docker-compose up -d

# Check if it's running
docker-compose logs -f
```

## 2️⃣ Access from iPad

1. Open Safari on your iPad
2. Navigate to: `http://YOUR-NAS-IP:3000`
3. Click "Login with Twitch"
4. Authorize the app
5. Done! You can now browse and watch streams

## 3️⃣ Watch a Stream

1. Go to the **Live** tab (shows your followed channels that are live)
2. Click on any stream card
3. A modal will pop up with the stream URL
4. **Option A:** Copy the URL and open it in VLC app
5. **Option B:** Click "Open in VLC" button
6. Enjoy! 🎉

## 🔧 Troubleshooting

### Can't access from iPad?

```bash
# Check if container is running
docker ps | grep streamlink

# Check logs
docker-compose logs

# Restart
docker-compose restart
```

### Login not working?

Make sure you edited `config/config.json` with your **actual NAS IP address**, not `localhost` or `YOUR-NAS-IP`!

```json
"redirectUri": "http://192.168.1.100:3000/auth/callback"
                      ^^^^^^^^^^^^^^^^
                      Your actual NAS IP!
```

### Stream won't start?

- Make sure the channel is actually live on Twitch
- Check Docker logs: `docker-compose logs -f`

## 📱 Pro Tips

### Add to Home Screen (iOS)

Make it feel like a native app:

1. Open the web interface in Safari
2. Tap the Share button (square with arrow)
3. Scroll down and tap "Add to Home Screen"
4. Give it a name like "Streamlink"
5. Tap "Add"

Now you have a dedicated app icon! 🎮

### VLC for iOS

Install VLC from the App Store for the best streaming experience:

https://apps.apple.com/app/vlc-for-mobile/id650377962

### Multiple Streams

You can have up to **10 streams** running simultaneously! Just start multiple streams and they'll be on different ports (8080-8089).

## 🆘 Need Help?

Check the full README.md for detailed documentation and troubleshooting.

---

**That's it! Enjoy streaming from your iPad! 📺**
