# 🔧 Streamlink Pfad konfigurieren

## Problem
Die App muss wissen, wo `streamlink.exe` auf deinem System liegt.

## 📍 Finde deinen Streamlink-Pfad

### Option 1: CMD / PowerShell
```cmd
where streamlink
```

Oder:
```powershell
Get-Command streamlink
```

### Option 2: Manuelle Suche
Typische Installationsorte:

**Python pip Installation:**
```
C:\Users\DEIN-NAME\AppData\Roaming\Python\Python3XX\Scripts\streamlink.exe
```

**Offizielle Windows Installer:**
```
C:\Program Files\Streamlink\bin\streamlink.exe
C:\Program Files (x86)\Streamlink\bin\streamlink.exe
```

**Portable Installation:**
```
Wo auch immer du es entpackt hast
```

## ⚙️ Konfiguriere den Pfad

### Schritt 1: Öffne die Config
```
streamlink-remote/config/config.json
```

### Schritt 2: Trage den Pfad ein

**Wichtig:** Verwende **doppelte Backslashes** (`\\`) oder **forward slashes** (`/`)!

**Beispiel für Python pip:**
```json
{
  "streamlink": {
    "executable": "C:\\Users\\pgrea\\AppData\\Roaming\\Python\\Python312\\Scripts\\streamlink.exe",
    "defaultQuality": "best",
    ...
  }
}
```

**Beispiel für offiziellen Installer:**
```json
{
  "streamlink": {
    "executable": "C:\\Program Files\\Streamlink\\bin\\streamlink.exe",
    "defaultQuality": "best",
    ...
  }
}
```

**Alternative mit Forward Slashes (funktioniert auch auf Windows!):**
```json
{
  "streamlink": {
    "executable": "C:/Users/pgrea/AppData/Roaming/Python/Python312/Scripts/streamlink.exe",
    "defaultQuality": "best",
    ...
  }
}
```

### Schritt 3: Teste den Pfad

Öffne CMD und teste:
```cmd
"C:\Users\pgrea\AppData\Roaming\Python\Python312\Scripts\streamlink.exe" --version
```

Sollte ausgeben:
```
streamlink X.X.X
```

### Schritt 4: Server neu starten

```bash
# Im Terminal wo der Server läuft:
Ctrl+C

# Neu starten:
npm start
```

### Schritt 5: In der App testen

1. Öffne http://localhost:3000
2. Gehe zu "Featured" oder "Search"
3. Klicke auf einen Stream
4. Wenn alles klappt: Stream startet! 🎉

## 🧪 Schnelltest ohne App

Du kannst Streamlink direkt testen:

```cmd
streamlink twitch.tv/shroud best --player-external-http --player-external-http-port 8080
```

Dann öffne im Browser:
```
http://localhost:8080
```

Sollte den Stream zeigen!

## ❌ Troubleshooting

### "streamlink: command not found"
**Problem:** Streamlink ist nicht im PATH oder nicht installiert

**Lösung:**
1. Prüfe ob Streamlink installiert ist
2. Finde den vollständigen Pfad
3. Trage in `config.json` ein

### "EPERM: operation not permitted"
**Problem:** Keine Berechtigung für streamlink.exe

**Lösung:**
- Rechtsklick auf streamlink.exe → Eigenschaften → Sicherheit
- Stelle sicher, dass dein User Lese- und Ausführungsrechte hat

### "No module named 'streamlink'"
**Problem:** Python kann streamlink nicht finden

**Lösung:**
```cmd
pip install --upgrade streamlink
```

### Stream startet, aber URL lädt nicht
**Problem:** Firewall blockiert Port

**Lösung:**
- Windows Firewall → Port 8080-8089 freigeben
- Oder teste mit `http://127.0.0.1:8080` statt `localhost`

## 📝 Vollständige config.json Beispiel

```json
{
  "server": {
    "port": 3000,
    "host": "0.0.0.0",
    "streamPortStart": 8080,
    "streamPortEnd": 8089
  },
  "twitch": {
    "clientId": "kimne78kx3ncx6brgo4mv6wki5h1ko",
    "redirectUri": "http://localhost:3000/auth/callback",
    "scopes": ["user:read:follows"],
    "apiBaseUrl": "https://api.twitch.tv/helix"
  },
  "streamlink": {
    "executable": "C:/Users/pgrea/AppData/Roaming/Python/Python312/Scripts/streamlink.exe",
    "defaultQuality": "best",
    "timeout": 60,
    "retryStreams": 1,
    "retryOpen": 1
  },
  "database": {
    "path": "./data/streamlink-remote.db"
  }
}
```

## 🎯 Nächste Schritte

1. ✅ Finde deinen Streamlink-Pfad
2. ✅ Trage ihn in `config.json` ein
3. ✅ Server neu starten
4. ✅ Stream testen in der App!

---

**Aktueller Pfad in deiner Config:**
```
C:\Users\pgrea\AppData\Roaming\Python\Python312\Scripts\streamlink.exe
```

**Prüfe ob dieser Pfad existiert!**
Wenn nicht, passe an.
