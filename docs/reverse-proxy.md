# HTTPS hinter einem Reverse Proxy

BlaulichtCMS spricht selbst nur HTTP auf Port 7310. HTTPS endet am vorhandenen Reverse Proxy.

## Grundeinstellungen

In der `.env`:

```dotenv
BLAULICHTCMS_BIND=127.0.0.1   # nur, wenn der Proxy auf demselben Host läuft
TRUSTED_PROXIES=private   # besser enger: Netz bzw. Adresse des Proxys, siehe unten
COOKIE_SECURE=true
```

### Vertrauenswürdige Proxys (`TRUSTED_PROXIES`)

Sperren nach Fehlversuchen, Rate-Limits und die IP im Audit-Protokoll hängen an der Client-IP. Hinter einem Proxy
steht sie im Header `X-Forwarded-For` – den aber auch jeder Client selbst mitschicken kann. BlaulichtCMS glaubt dem Header
deshalb nur bei Verbindungen von den in `TRUSTED_PROXIES` eingetragenen Adressen und nimmt den **rechtesten** Eintrag,
der nicht selbst ein eingetragener Proxy ist (das ist die Adresse, die der Proxy angehängt hat). Ein vom Client
vorangestellter Wert bleibt wirkungslos.

| Wert | Bedeutung |
|---|---|
| leer | kein Proxy, Header wird ignoriert (Zugriff direkt auf BlaulichtCMS) |
| `172.18.0.0/16` | Netz des Proxy-Containers, z. B. `proxy-net` (`docker network inspect proxy-net -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}'`) |
| `192.168.1.20` | einzelner Proxy-Server, z. B. IIS auf einem anderen Host |
| `private` | alle privaten Bereiche (`loopback`, `linklocal`, `uniquelocal`); Standard von `install.sh` |

Mehrere Werte mit Komma oder Leerzeichen trennen. `private` ist bequem, glaubt aber auch anderen Containern im selben
Docker-Netz und Clients, die selbst eine private Adresse haben (z. B. aus dem eigenen LAN über den Proxy). Für den
Echtbetrieb deshalb die Adresse oder das Netz des Proxys eintragen. Ein Proxy auf demselben Host, der über den
veröffentlichten Port `127.0.0.1:7310` zugreift, erscheint mit der Gateway-Adresse des Docker-Netzes (z. B.
`172.18.0.1`).

Zusätzlich empfohlen: Der Proxy ersetzt den Header, statt ihn zu ergänzen (`proxy_set_header X-Forwarded-For
$remote_addr;`). Dann kommt ein vom Client mitgeschickter Wert gar nicht erst an.

Ältere `.env` mit `TRUST_PROXY=true` (vertraute bis Version 0.1 jedem Header) wirken wie `TRUSTED_PROXIES=private`;
BlaulichtCMS schreibt dann beim Start eine Warnung, `install.sh` ergänzt `TRUSTED_PROXIES` beim nächsten Update.

Im Erstsetup die öffentliche Adresse eintragen, z. B. `https://blaulichtcms.example.org`.
Sie erscheint in Einladungen, Upload-Links und QR-Codes.

Wichtig für den Proxy:

- `Host`, `X-Forwarded-For` und `X-Forwarded-Proto` weiterreichen.
- Upload-Größe passend zur Einstellung „Maximale Dateigröße“ erlauben (Standard 2048 MB).
- Lange Zeitlimits für Uploads großer Videos (z. B. 30 Minuten).
- Kein Pufferung von Anfragen erzwingen, die die Upload-Fortschrittsanzeige verfälscht.

## Nginx Proxy Manager

BlaulichtCMS hängt im Docker-Netz `proxy-net`; der Proxy-Container muss ebenfalls darin sein
(`docker network connect proxy-net <npm-container>`, falls noch nicht geschehen).

*Hosts → Proxy Hosts → Add Proxy Host*:

| Feld | Wert |
|---|---|
| Domain Names | `blaulichtcms.example.org` |
| Scheme / Forward Hostname / Port | `http` / `blaulichtcms` / `7310` |
| Block Common Exploits | an |
| SSL | Zertifikat anfordern, *Force SSL* und *HTTP/2* an |

Unter *Advanced* (Uploads großer Videos, echte Client-IP):

```nginx
client_max_body_size 2g;
proxy_request_buffering off;
proxy_read_timeout 1800s;
proxy_send_timeout 1800s;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For $remote_addr;
access_log off;   # Upload-Links enthalten Zugangsschlüssel – nicht protokollieren (siehe unten)
```

`install.sh` zeigt genau diese Werte an, verbindet einen erkannten Proxy-Container auf Wunsch mit `proxy-net`, setzt in
der `.env` `TRUSTED_PROXIES` auf das Netz von `proxy-net` und `COOKIE_SECURE=true` und prüft am Ende die öffentliche
Adresse.

## IIS auf einem anderen Server

`BLAULICHTCMS_BIND` auf die LAN-Adresse des Docker-Hosts setzen, Port 7310 per Firewall nur für den IIS-Server freigeben.
Im IIS (ARR + URL Rewrite) auf `http://<docker-host>:7310` weiterleiten, `X-Forwarded-Proto` setzen und die
Anfragegröße (`maxAllowedContentLength`) auf mindestens 2 GB stellen. In der `.env`: `TRUSTED_PROXIES=<IP des IIS-Servers>`.

## Caddy

```caddyfile
blaulichtcms.example.org {
	request_body {
		max_size 2GB
	}
	reverse_proxy 127.0.0.1:7310 {
		transport http {
			read_timeout 30m
			write_timeout 30m
		}
	}
}
```

## nginx

```nginx
server {
    listen 443 ssl http2;
    server_name blaulichtcms.example.org;
    # ssl_certificate …; ssl_certificate_key …;

    client_max_body_size 2g;
    proxy_request_buffering off;
    proxy_read_timeout 1800s;
    proxy_send_timeout 1800s;

    location / {
        proxy_pass http://127.0.0.1:7310;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Traefik (Labels für compose.yaml)

```yaml
    labels:
      - traefik.enable=true
      - traefik.http.routers.blaulichtcms.rule=Host(`blaulichtcms.example.org`)
      - traefik.http.routers.blaulichtcms.entrypoints=websecure
      - traefik.http.routers.blaulichtcms.tls.certresolver=letsencrypt
      - traefik.http.services.blaulichtcms.loadbalancer.server.port=7310
```

## HAProxy (z. B. OPNsense)

```haproxy
backend blaulichtcms
    mode http
    option forwardfor
    http-request set-header X-Forwarded-Proto https
    timeout server 30m
    server blaulichtcms 10.0.0.20:7310 check
```

## Was von außen erreichbar sein muss

| Pfad | Wer | Hinweis |
|---|---|---|
| `/u/…`, `/api/v1/public/upload/…` | Personen mit Upload-Link | ohne Konto |
| `/api/v1/bridge/…` | WordPress-Website (Bridge) | eigener Schlüssel je Website |
| alles andere | Redaktion | kann zusätzlich auf interne Netze/VPN beschränkt werden |

## Zugriffsprotokolle des Proxys (Datenschutz)

Einige öffentliche Adressen tragen ein Token im Pfad. Wer das Token aus einem Protokoll liest, kann – solange der
Link gilt – über ihn hochladen bzw. die Datei abrufen. Zusammen mit der Client-IP sind die Zeilen außerdem
personenbezogene Daten der hochladenden Personen (Art. 5 Abs. 1 lit. c und e, Art. 32 DSGVO).

| Pfad | Token | Wer ruft auf |
|---|---|---|
| `/u/<token>` | Upload-Link | Personen mit Link/QR-Code |
| `/api/v1/public/upload/<token>…` | Upload-Link | Upload-Seite (jeder Dateiteil eine Anfrage) |
| `/l/<token>` | alter Link aus dem Import (Weiterleitung) | Personen mit altem Link |
| `/api/v1/m/<token>` | kurzlebige Medienadresse (höchstens 24 Stunden) | Meta beim Veröffentlichen auf Facebook/Instagram/Threads; Personen beim Teilen von Hand (Dateien herunterladen) |
| `/einladung/<token>`, `/api/v1/auth/invite/<token>` | Einladung bzw. Passwort-Link | neue Konten, Passwort zurücksetzen |
| `/api/v1/inbound/fe2/<id>/<token>` | FE2-Schlüssel – nur mit der Option „Schlüssel in der Adresse“; gilt bis zur Erneuerung | FE2 bei jedem Einsatz |

BlaulichtCMS selbst schreibt diese Tokens nirgends hin: das Systemprotokoll enthält nur die Routenvorlage
(`/api/v1/public/upload/:token`), das Audit die IP öffentlicher Uploads und entfernt sie nach
`privacy.upload_ip_retention_days` (Standard 30 Tage). Das Token in der Adresse bleibt bewusst: gedruckte QR-Codes
müssen funktionieren, Einladungen werden als Link verschickt und Meta lädt Medien nur über eine Adresse. Der Proxy sollte deshalb **eines** davon tun:

1. **Zugriffsprotokoll für BlaulichtCMS abschalten** (einfachste Lösung). Sicherheitsrelevante Ereignisse protokolliert
   BlaulichtCMS selbst im Audit; Fehler des Proxys stehen weiter im Fehlerprotokoll.
2. **Tokens maskieren und IP kürzen**, wenn Zugriffsprotokolle gebraucht werden (z. B. für Angriffsanalysen).

In beiden Fällen die Protokolle kurz halten: **höchstens 7 Tage**, danach löschen (Logrotation). Für die Auswertung
von Angriffen reicht das zusammen mit dem Audit.

### Nginx Proxy Manager

Im Proxy Host unter *Advanced* zusätzlich zu den Zeilen oben:

```nginx
access_log off;
```

Nginx Proxy Manager setzt sein eigenes Logformat; ein maskierendes Format lässt sich dort nur mit eigenen
`location`-Blöcken nachbauen. Wer Zugriffsprotokolle braucht, nimmt deshalb besser nginx oder Caddy wie unten. Nach
der Änderung eine Testdatei hochladen und prüfen, dass `/data/logs/proxy-host-<nr>_access.log` keine neuen Zeilen mit
`/u/` bzw. `/api/v1/public/upload/` mehr bekommt. Ältere Protokolle mit Tokens löschen. Die Rotation der übrigen
Protokolle steht im Container unter `/etc/logrotate.d/nginx-proxy-manager` (auf `daily` und `rotate 7` stellen; nach
einem Update des Proxys erneut prüfen).

### nginx

Im `http`-Block ein Format ohne Token und mit gekürzter IP (IPv4 /24, IPv6 /48) definieren:

```nginx
map $request_uri $bc_uri {
    "~^(?<bc_p>/u/|/l/|/einladung/|/api/v1/public/upload/|/api/v1/auth/invite/|/api/v1/m/|/api/v1/inbound/fe2/[^/?]+/)[^/?]+(?<bc_r>[^?]*)" "${bc_p}***${bc_r}";
    "~^(?<bc_q>[^?]*)"                                                        "$bc_q";
}
map $remote_addr $bc_ip {
    "~^(?<bc_a>\d+\.\d+\.\d+)\."                    "${bc_a}.0";
    "~^(?<bc_b>[0-9a-fA-F]*:[0-9a-fA-F]*:[0-9a-fA-F]*)" "${bc_b}::";
    default                                         "-";
}
log_format blaulichtcms '$bc_ip [$time_local] "$request_method $bc_uri" $status $body_bytes_sent';
```

Im `server`-Block von BlaulichtCMS:

```nginx
access_log /var/log/nginx/blaulichtcms.access.log blaulichtcms;
```

Abfrageparameter werden dabei weggelassen. Logrotation in `/etc/logrotate.d/nginx`: `daily`, `rotate 7`.

### Caddy

Caddy schreibt Zugriffsprotokolle nur mit der Direktive `log`. Ohne `log` im Block von BlaulichtCMS entsteht keins. Mit
Protokoll:

```caddyfile
blaulichtcms.example.org {
	log {
		output file /var/log/caddy/blaulichtcms.log {
			roll_keep_for 168h
		}
		format filter {
			request>uri regexp "^(/u/|/l/|/einladung/|/api/v1/public/upload/|/api/v1/auth/invite/|/api/v1/m/|/api/v1/inbound/fe2/[^/?]+/)[^/?]+([^?]*).*$" "${1}***${2}"
			request>remote_ip ip_mask 24 48
			request>client_ip ip_mask 24 48
			request>headers delete
		}
	}
	# … reverse_proxy wie oben …
}
```

### Andere Proxys

- **Traefik:** `accesslog.fields.names.RequestPath=drop`, `accesslog.fields.names.ClientHost=drop` (bzw. ganz ohne
  `accesslog`), `accesslog.fields.headers.defaultmode=drop`.
- **IIS:** in der Protokollierung der Site die Felder `cs-uri-stem`, `cs-uri-query` und `c-ip` abwählen oder die
  Protokollierung für die Site abschalten; Löschung alter Dateien per geplanter Aufgabe (7 Tage).
- **HAProxy:** ohne `option httplog` für das BlaulichtCMS-Frontend bzw. mit eigenem `log-format` ohne `%r`/`%HU`.

Auch Protokolle, die vor dieser Einstellung entstanden sind, enthalten Tokens: löschen oder bis zum Ablauf der
Upload-Links (höchstens 90 Tage) unter Verschluss halten. Steht ein FE2-Schlüssel in einem alten Protokoll, in der
FE2-Verbindung einen neuen Zugangsschlüssel erzeugen – er gilt sonst unbefristet. Die Fristen gehören in das Verzeichnis der
Verarbeitungstätigkeiten ([datenschutz.md](datenschutz.md)).
