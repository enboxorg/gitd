# Deploying gitd

`gitd serve` runs a plain HTTP server (default port 9418). It does **not**
terminate TLS — you need a reverse proxy in front of it to provide HTTPS.

## Quick start

```sh
# 1. Initialize a profile and create a repo
gitd auth login
gitd init my-repo

# 2. Serve locally (development only)
gitd serve

# 3. Serve publicly (requires a domain with TLS)
gitd serve --public-url https://git.example.com

# 4. Validate the public URL is reachable
gitd serve --public-url https://git.example.com --check
```

## Key concepts

### `--public-url`

When `--public-url` (or `GITD_PUBLIC_URL`) is provided, `gitd serve`:

1. Registers a `GitTransport` service entry in the DID document so
   `git-remote-did` can discover the endpoint.
2. Populates `gitEndpoints` on all repo records.
3. Starts a DID DHT republisher that keeps the `did:dht` record alive
   (DHT records expire after ~2 hours; the republisher runs every hour).

Without `--public-url`, remote clients can only reach your repos through
the DWN endpoint fallback (slower, proxied through the DWN relay).

### `--check`

`gitd serve --public-url <url> --check` probes the `/health` endpoint of
the public URL and exits with code 0 on success or 1 on failure. Use this
to validate that your reverse proxy is correctly forwarding traffic before
going live.

### DID republishing

`did:dht` records are stored on the Mainline DHT with a TTL of ~2 hours.
While `gitd serve` is running, it automatically republishes the DID
document every hour. If the server stops, the DID will become unresolvable
after the TTL expires. For production deployments, keep `gitd serve`
running continuously (e.g. via systemd or a container orchestrator).

## Deployment scenarios

### VPS with a domain name

The simplest production setup: a VPS with a domain pointed at it, a
reverse proxy for TLS, and gitd running behind it.

#### Caddy (automatic TLS)

```caddyfile
git.example.com {
    reverse_proxy localhost:9418
}
```

```sh
# Start Caddy
sudo caddy start

# Start gitd
gitd serve --public-url https://git.example.com
```

Caddy automatically provisions and renews Let's Encrypt certificates.

#### nginx + certbot

```nginx
server {
    listen 443 ssl http2;
    server_name git.example.com;

    ssl_certificate     /etc/letsencrypt/live/git.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/git.example.com/privkey.pem;

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:9418;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name git.example.com;
    return 301 https://$host$request_uri;
}
```

```sh
# Obtain a certificate
sudo certbot --nginx -d git.example.com

# Start gitd
gitd serve --public-url https://git.example.com
```

### systemd service

Create `/etc/systemd/system/gitd.service`:

```ini
[Unit]
Description=gitd — decentralized git forge
After=network.target

[Service]
Type=simple
User=gitd
WorkingDirectory=/home/gitd
ExecStart=/usr/local/bin/gitd serve --public-url https://git.example.com
Restart=always
RestartSec=5
Environment=GITD_PASSWORD=<vault-password>
Environment=GITD_PORT=9418

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now gitd
```

### Docker

```dockerfile
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
EXPOSE 9418
CMD ["bun", "run", "dist/esm/cli/main.js", "serve"]
```

```sh
docker build -t gitd .
docker run -d \
  -p 9418:9418 \
  -e GITD_PASSWORD=changeme \
  -e GITD_PUBLIC_URL=https://git.example.com \
  -v gitd-data:/app/.enbox \
  gitd
```

### Cloud platforms

#### fly.io

```toml
# fly.toml
app = "my-gitd"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  GITD_PORT = "9418"
  GITD_PUBLIC_URL = "https://my-gitd.fly.dev"

[http_service]
  internal_port = 9418
  force_https = true

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"

[mounts]
  source = "gitd_data"
  destination = "/app/.enbox"
```

```sh
fly launch
fly secrets set GITD_PASSWORD=changeme
fly deploy
```

#### Railway / Render

Both platforms auto-detect Dockerfiles. Set these environment variables:

| Variable          | Value                              |
|-------------------|------------------------------------|
| `GITD_PASSWORD`   | Your vault password                |
| `GITD_PUBLIC_URL` | `https://<app-name>.<platform>.app`|
| `GITD_PORT`       | The port your platform expects     |

### Home server with dynamic DNS

If your IP changes, use a dynamic DNS provider (e.g. DuckDNS, Cloudflare
DDNS, or no-ip) to keep a hostname pointed at your home IP.

```sh
# Example with DuckDNS
echo url="https://www.duckdns.org/update?domains=mygitd&token=TOKEN&ip=" | curl -k -o /dev/null -K -

# Port-forward 443 → your server in your router settings
# Use Caddy or nginx for TLS as shown above

gitd serve --public-url https://mygitd.duckdns.org
```

### Tunnel (no port forwarding required)

If you cannot open ports, use a tunnel service:

```sh
# Cloudflare Tunnel
cloudflared tunnel --url http://localhost:9418

# Or use ngrok for testing
ngrok http 9418
```

Set `--public-url` to the tunnel URL provided by the service.

Note: tunnel URLs are ephemeral. The DID document will be updated with
the new URL each time the tunnel restarts, but cached DID resolutions on
remote clients may take time to update.

## Network requirements

| Port | Protocol | Direction | Purpose                  |
|------|----------|-----------|--------------------------|
| 9418 | TCP      | Inbound   | Git smart HTTP transport |
| 443  | TCP      | Inbound   | HTTPS (reverse proxy)    |
| 443  | TCP      | Outbound  | DWN sync, DID publishing |

- The server must be able to reach the DWN relay and DHT network on
  outbound HTTPS.
- Inbound traffic only needs to reach the reverse proxy port (443).
  The gitd port (9418) should be bound to localhost unless you want
  direct HTTP access.

## Environment variables

| Variable            | Default                          | Description                          |
|---------------------|----------------------------------|--------------------------------------|
| `GITD_PASSWORD`     | _(prompted)_                     | Vault password for the agent         |
| `GITD_PORT`         | `9418`                           | HTTP server port                     |
| `GITD_PUBLIC_URL`   | _(none)_                         | Public HTTPS URL for DID registration|
| `GITD_REPOS`        | `~/.enbox/profiles/<name>/repos` | Base path for bare git repositories  |
| `GITD_PREFIX`       | _(none)_                         | URL path prefix (e.g. `/git`)        |
| `GITD_SYNC`         | `30s` (serve), `off` (other)     | DWN sync interval                    |
| `GITD_DWN_ENDPOINT` | _(from DID document)_            | Explicit DWN endpoint URL            |
| `GITD_ALLOW_PRIVATE`| _(unset)_                        | Set to `1` to disable SSRF protection|

## Verifying your deployment

```sh
# 1. Check the health endpoint directly
curl https://git.example.com/health
# → {"status":"ok","service":"git-server"}

# 2. Use gitd's built-in check
gitd serve --public-url https://git.example.com --check

# 3. Clone a repo from another machine
git clone did::did:dht:abc123xyz/my-repo
```
