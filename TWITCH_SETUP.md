# 🎮 Twitch App Setup Guide

## Warum eine eigene Twitch App?

Die aktuelle Client-ID (`kimne78kx3ncx6brgo4mv6wki5h1ko`) ist Twitchs öffentliche Web-Client-ID.
**Sie funktioniert**, aber für eigene Apps solltest du deine eigene erstellen.

## 🔧 Schritt-für-Schritt: Twitch App erstellen

### 1. Gehe zu Twitch Developer Console
https://dev.twitch.tv/console

### 2. Login mit deinem Twitch Account
- Nutze deinen normalen Twitch-Account
- Bestätige per E-Mail falls nötig

### 3. Klicke auf "Register Your Application"

### 4. Fülle das Formular aus:

**Name:**
```
Streamlink Remote
```
(oder ein anderer Name deiner Wahl)

**OAuth Redirect URLs:**
```
http://localhost:3000/auth/callback
```

⚠️ **WICHTIG:** Später für dein NAS musst du noch hinzufügen:
```
http://YOUR-NAS-IP:3000/auth/callback
```
Beispiel: `http://192.168.1.100:3000/auth/callback`

**Category:**
```
Application Integration
```

### 5. Klicke "Create"

### 6. Kopiere deine Credentials:

Nach dem Erstellen siehst du:
- **Client ID** - Das brauchst du!
- **Client Secret** - NICHT nötig für unsere App (wir nutzen Implicit Flow)

### 7. Trage die Client ID in die Config ein:

Öffne: `streamlink-remote/config/config.json`

```json
{
  "twitch": {
    "clientId": "DEINE-CLIENT-ID-HIER",
    "redirectUri": "http://localhost:3000/auth/callback",
    "scopes": ["user:read:follows"],
    "apiBaseUrl": "https://api.twitch.tv/helix"
  }
}
```

### 8. Server neu starten
```bash
# Stoppe den Server (Ctrl+C)
# Starte neu:
npm start
```

### 9. Testen
- Öffne http://localhost:3000
- Klicke "Login with Twitch"
- Autorisiere deine App
- Fertig! ✅

## 🔒 Sicherheit

- **Client Secret:** Brauchst du NICHT (ist für server-seitige Apps)
- **Client ID:** Kann öffentlich sein (steht im Frontend-Code)
- **Access Token:** Wird sicher im Backend gespeichert

## 🌐 Für NAS/Remote-Zugriff

Wenn du die App auf dein NAS deployest:

1. **Gehe zurück zur Twitch Developer Console**
2. **Bearbeite deine App**
3. **Füge hinzu zu "OAuth Redirect URLs":**
   ```
   http://192.168.1.100:3000/auth/callback
   ```
   (Ersetze mit deiner NAS-IP)

4. **Speichern**

5. **Update config.json auf dem NAS:**
   ```json
   "redirectUri": "http://192.168.1.100:3000/auth/callback"
   ```

## ❓ Warum funktioniert die Standard Client-ID?

Die ID `kimne78kx3ncx6brgo4mv6wki5h1ko` ist Twitchs offizielle Web-Client-ID.
Sie ist öffentlich und wird von vielen Tools verwendet (auch Streamlink selbst).

**Vorteile:**
- ✅ Funktioniert sofort ohne Setup
- ✅ Keine eigene App nötig
- ✅ Redirect zu localhost ist bereits registriert

**Nachteile:**
- ⚠️ Nicht "deine" App
- ⚠️ Könnte theoretisch von Twitch geändert werden
- ⚠️ Weniger professionell

**Für Testing:** Standard-ID ist OK
**Für Production:** Eigene App empfohlen

## 🎯 Empfehlung

Für's Testing jetzt:
- ✅ Nutze die Standard Client-ID (funktioniert!)
- ✅ Login sollte funktionieren

Später für Production:
- 📝 Erstelle eigene Twitch App
- 📝 Trage eigene Client-ID ein
- 📝 Füge NAS-IP als Redirect hinzu

---

**Du kannst jetzt mit der Standard-ID testen!**
Login sollte funktionieren. Falls nicht, sag Bescheid!
