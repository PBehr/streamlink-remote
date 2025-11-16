# 🔧 Quick Fix: Twitch Login Problem

## Problem
Das Twitch Login-Popup öffnet sich, aber die Autorisierung kommt nicht zurück zur App.

## Ursache
Die verwendete Client-ID hat `http://localhost:3000/auth/callback` nicht als erlaubte Redirect-URL registriert.

## ✅ Lösung: Eigene Twitch App erstellen (5 Minuten!)

### Schritt 1: Gehe zu Twitch Developer Console
Öffne: https://dev.twitch.tv/console

### Schritt 2: Login
Mit deinem normalen Twitch-Account einloggen

### Schritt 3: Register Application
Klicke auf **"Register Your Application"**

### Schritt 4: Fülle aus:

**Name:**
```
My Streamlink Remote
```
(oder beliebiger Name)

**OAuth Redirect URLs:**
```
http://localhost:3000/auth/callback
```

**Category:**
```
Application Integration
```

### Schritt 5: Create
Klicke auf "Create"

### Schritt 6: Client ID kopieren
Nach dem Erstellen:
- Klicke auf "Manage"
- Kopiere die **Client ID** (lange Zeichenfolge)

### Schritt 7: In Config eintragen

Öffne: `streamlink-remote/config/config.json`

Ändere diese Zeile:
```json
"clientId": "DEINE-CLIENT-ID-HIER",
```

Beispiel:
```json
{
  "twitch": {
    "clientId": "abc123xyz789...",
    "redirectUri": "http://localhost:3000/auth/callback",
    "scopes": ["user:read:follows"],
    "apiBaseUrl": "https://api.twitch.tv/helix"
  }
}
```

### Schritt 8: Server neu starten

**Option A:** Doppelklick auf `restart.bat`

**Option B:** Im Terminal:
```bash
Ctrl+C
npm start
```

### Schritt 9: Testen
1. Öffne http://localhost:3000
2. Klicke "Login with Twitch"
3. Autorisiere deine App
4. Sollte jetzt funktionieren! ✅

---

## 🚀 Alternative: Token manuell eingeben (Notfall)

Falls die App-Erstellung nicht klappt, können wir einen manuellen Token-Eingabe-Modus bauen.
Sag Bescheid wenn du das brauchst!

---

## ❓ Troubleshooting

### "Invalid Redirect URI"
**Problem:** Redirect-URL falsch geschrieben

**Lösung:**
- In Twitch Dev Console: Genau `http://localhost:3000/auth/callback`
- Kein Leerzeichen, kein `https`, kein trailing slash

### "Client ID not found"
**Problem:** Client ID falsch kopiert

**Lösung:**
- Client ID nochmal kopieren (ohne Leerzeichen!)
- In config.json zwischen Anführungszeichen
- Server neu starten

### Popup wird blockiert
**Problem:** Browser blockiert Popups

**Lösung:**
- Browser-Einstellungen: Popups für localhost erlauben
- Oder: HTTPS-Icons in der URL-Leiste klicken → Popups erlauben

---

**Nach diesen Schritten sollte der Login funktionieren! 🎉**
