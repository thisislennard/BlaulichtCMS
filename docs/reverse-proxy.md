# HTTPS hinter einem Reverse Proxy

LifeLink spricht selbst nur HTTP auf Port 7310. HTTPS endet am vorhandenen Reverse Proxy.

## Grundeinstellungen

In der `.env`:

```dotenv
LIFELINK_BIND=127.0.0.1   # nur, wenn der Proxy auf demselben Host läuft
TRUST_PROXY=true
COOKIE_SECURE=true
```

Im Erstsetup die öffentliche Adresse eintragen, z. B. `https://lifelink.example.org`.
Sie erscheint in Einladungen, Upload-Links und QR-Codes.

Wichtig für den Proxy:

- `Host`, `X-Forwarded-For` und `X-Forwarded-Proto` weiterreichen.
- Upload-Größe passend zur Einstellung „Maximale Dateigröße“ erlauben (Standard 2048 MB).
- Lange Zeitlimits für Uploads großer Videos (z. B. 30 Minuten).
- Kein Pufferung von Anfragen erzwingen, die die Upload-Fortschrittsanzeige verfälscht.

## Caddy

```caddyfile
lifelink.example.org {
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
    server_name lifelink.example.org;
    # ssl_certificate …; ssl_certificate_key …;

    client_max_body_size 2g;
    proxy_request_buffering off;
    proxy_read_timeout 1800s;
    proxy_send_timeout 1800s;

    location / {
        proxy_pass http://127.0.0.1:7310;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Traefik (Labels für compose.yaml)

```yaml
    labels:
      - traefik.enable=true
      - traefik.http.routers.lifelink.rule=Host(`lifelink.example.org`)
      - traefik.http.routers.lifelink.entrypoints=websecure
      - traefik.http.routers.lifelink.tls.certresolver=letsencrypt
      - traefik.http.services.lifelink.loadbalancer.server.port=7310
```

## HAProxy (z. B. OPNsense)

```haproxy
backend lifelink
    mode http
    option forwardfor
    http-request set-header X-Forwarded-Proto https
    timeout server 30m
    server lifelink 10.0.0.20:7310 check
```

## Was von außen erreichbar sein muss

| Pfad | Wer | Hinweis |
|---|---|---|
| `/u/…`, `/api/v1/public/upload/…` | Personen mit Upload-Link | ohne Konto |
| `/api/v1/bridge/…` | WordPress-Website (Bridge) | eigener Schlüssel je Website |
| alles andere | Redaktion | kann zusätzlich auf interne Netze/VPN beschränkt werden |
