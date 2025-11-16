# 🧪 Testing Guide - Streamlink Remote

## ✅ Status: Server läuft auf http://localhost:3000

Der Server wurde erfolgreich gestartet und ist bereit zum Testen!

## 📋 Test-Checkliste

### 1. Web UI Öffnen
- [ ] Öffne deinen Browser
- [ ] Navigiere zu: http://localhost:3000
- [ ] Die Streamlink Remote UI sollte laden

### 2. Twitch Login Testen
- [ ] Klicke auf "Login with Twitch" Button
- [ ] Ein neues Fenster öffnet sich mit Twitch OAuth
- [ ] Autorisiere die App
- [ ] Das Fenster sollte sich schließen und du bist eingeloggt
- [ ] Dein Twitch-Username sollte oben rechts angezeigt werden

### 3. Featured Streams Browsing
- [ ] Klicke auf den "Featured" Tab
- [ ] Top Twitch-Streams sollten angezeigt werden
- [ ] Thumbnails und Stream-Infos sollten sichtbar sein

### 4. Live Streams (Followed Channels)
- [ ] Nach dem Login: Klicke auf "Live" Tab
- [ ] Live Streams deiner gefolgten Kanäle werden angezeigt
- [ ] Falls keine live sind: "No live streams" Nachricht

### 5. Search Funktion
- [ ] Klicke auf "Search" Tab
- [ ] Gib einen Channel-Namen ein (z.B. "shroud", "xqc")
- [ ] Klicke "Search"
- [ ] Suchergebnisse werden angezeigt

### 6. Stream Starten (WICHTIG: Erfordert Streamlink!)
⚠️ **Du benötigst Streamlink installiert auf deinem PC**

**Streamlink installieren:**
- Windows: https://streamlink.github.io/install.html#windows-binaries
- Nach Installation: `streamlink --version` in CMD testen

**Dann:**
- [ ] Klicke auf einen Stream
- [ ] Modal öffnet sich mit "Stream läuft"
- [ ] HTTP-URL wird angezeigt (z.B. http://localhost:8080/)
- [ ] Kopiere die URL

**Test Option A: Im Browser**
- [ ] Öffne die URL direkt im Browser
- [ ] Stream sollte starten (manche Browser unterstützen HLS nativ)

**Test Option B: In VLC**
- [ ] VLC öffnen → Media → Open Network Stream
- [ ] URL einfügen
- [ ] Play → Stream sollte laufen!

### 7. Active Streams
- [ ] Klicke auf "Active" Tab
- [ ] Laufende Streams werden aufgelistet
- [ ] URL ist kopierbar
- [ ] "Stop Stream" Button funktioniert

### 8. Settings
- [ ] Klicke auf "Settings" Tab
- [ ] Ändere "Default Quality" (z.B. zu 720p)
- [ ] Klicke "Save Settings"
- [ ] Toast-Notification "Settings saved" erscheint

### 9. WebSocket Live-Updates
- [ ] Starte einen Stream
- [ ] Während er läuft, öffne "Active" Tab in zweitem Browser-Tab
- [ ] Stream sollte dort automatisch erscheinen (Live-Update!)
- [ ] Stoppe den Stream → verschwindet sofort (Live-Update!)

### 10. Logout
- [ ] Klicke "Logout" Button (oben rechts oder in Settings)
- [ ] Du wirst ausgeloggt
- [ ] "Live" Tab zeigt Login-Aufforderung

## 🐛 Bekannte Einschränkungen (Testing auf Windows)

### 1. Streamlink muss installiert sein
Falls Streamlink NICHT installiert ist:
- Streams können nicht gestartet werden
- Fehlermeldung: "Streamlink not found" oder ähnlich
- **Lösung:** Streamlink installieren oder nur UI/API testen

### 2. In-Memory Database
- Daten werden NICHT gespeichert nach Server-Neustart
- Auth-Token geht verloren wenn Server stoppt
- **Für Production:** Verwende Docker mit echtem SQLite

### 3. Windows vs. Linux
- Pfade könnten anders sein
- `streamlink.exe` statt `streamlink`
- Sollte aber automatisch erkannt werden

## 📊 Test-Szenarien

### Scenario 1: Vollständiger User-Flow
1. Öffne App
2. Login mit Twitch
3. Browse Featured Streams
4. Starte einen Stream
5. Kopiere URL → öffne in VLC
6. Gehe zu Active Tab → sieh laufenden Stream
7. Stoppe Stream
8. Logout

### Scenario 2: Multi-Stream
1. Starte Stream A
2. Starte Stream B
3. Starte Stream C
4. Alle 3 laufen auf verschiedenen Ports (8080, 8081, 8082)
5. "Active" Tab zeigt alle 3
6. Stoppe alle einzeln

### Scenario 3: WebSocket Test
1. Öffne App in zwei Browser-Tabs
2. Tab 1: Starte einen Stream
3. Tab 2 (Active Tab): Stream erscheint sofort
4. Tab 1: Stoppe Stream
5. Tab 2: Stream verschwindet sofort

## 🔧 Troubleshooting

### Problem: "Cannot GET /"
**Lösung:** Server nicht gestartet oder falscher Port
```bash
cd streamlink-remote
npm start
```

### Problem: Login schlägt fehl
**Mögliche Ursachen:**
1. Popup wurde blockiert → Browser-Einstellungen prüfen
2. Twitch OAuth kaputt → Neu versuchen
3. Network-Fehler → Console checken (F12)

### Problem: Stream startet nicht
**Debug-Schritte:**
1. Ist Streamlink installiert? `streamlink --version`
2. Ist der Channel live? Auf Twitch.tv prüfen
3. Server-Logs checken: Terminal-Output ansehen
4. Error in Toast-Notification?

### Problem: WebSocket verbindet nicht
**Lösung:** Server-Neustart
```bash
# Terminal mit Ctrl+C stoppen
npm start
```

## 📸 Screenshots-Punkte

Wenn du Screenshots machen willst für Dokumentation:
1. Home Screen (Featured Streams)
2. Live Streams Tab (mit deinen Follows)
3. Stream Modal (mit URL)
4. Active Streams Tab
5. Settings Page

## ✅ Finale Checks vor Deployment

- [ ] Alle Tabs funktionieren
- [ ] Login/Logout funktioniert
- [ ] Featured Streams laden
- [ ] Search funktioniert
- [ ] Stream kann gestartet werden (mit Streamlink)
- [ ] WebSocket Updates funktionieren
- [ ] Settings speichern funktioniert
- [ ] Keine Console-Errors (F12)

## 🚀 Nächste Schritte

Nach erfolgreichem lokalen Test:
1. **Auf NAS deployen** - Docker-Setup nutzen
2. **Von iPad testen** - Gleiche URL, anderes Device
3. **Firewall konfigurieren** - Ports 3000 und 8080-8089 öffnen

---

**Server läuft auf:** http://localhost:3000
**API Status:** http://localhost:3000/api/status
**Server stoppen:** Ctrl+C im Terminal
**Server neu starten:** `npm start`

**Viel Spaß beim Testen! 🎉**
