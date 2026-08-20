# Deploying the PWA — nginx as a Service, Certificates, Tablets

The PWA is static files. Everything hard about deploying it is around them: nginx has to serve
those files **and** proxy `/api/` to the backend from the same origin, over TLS that Android will
accept, started by the machine rather than by a person.

The backend half is in [the backend's `docs/deployment.md`](../../../JavaProject/backend-offline-first/docs/deployment.md).
The two must agree on one thing above all: **the origin the tablet loads the app from is the
origin its API calls go to.** Get that wrong and every request is cross-origin, which means CORS,
which means the tablets work until they do not.

---

## Why TLS is not optional here

Not a policy preference — three features stop existing without it:

| Feature | Needs |
|---|---|
| **Web NFC** | A secure context. Over plain HTTP the API is simply absent, and scanning is the app's whole input method |
| **Service worker** | A secure context. No service worker, no offline |
| **Camera / microphone** | A secure context |

`localhost` counts as secure; a LAN IP does not. So a tablet reaching `http://192.168.1.4` gets an
app that installs, opens, and cannot scan, cannot cache, and cannot photograph. That failure looks
like "the app is broken", not like "TLS is missing".

---

## 1. Build

Build on a machine with network access. The plant host serves files; it needs no Node, no npm
registry, and no internet route.

```bash
npm ci
npm run build:mobile
# dist/
```

**`build:mobile`, not `build`.** It reads `.env.mobile`, which is where `VITE_SERVER_URL` — the
default server address baked into a fresh install — comes from:

```ini
# .env.mobile
VITE_SERVER_URL=https://192.168.1.4
```

Set it to the **PWA's own origin**, with no path and no trailing slash. When the stored server URL
matches `window.location.origin` the client uses relative paths (`/api/...`) and nginx proxies
them, which is the whole point of the same-origin setup. See
[README § Server URL rules](../README.md#server-url-rules-srcservicesapiclientts).

The output is self-contained: no CDN, no font host, no analytics. The only external strings in the
bundle are error-message URLs inside libraries, and nothing fetches them.

---

# Certificates

## Windows — mkcert

`mkcert` creates a local certificate authority, installs it into the Windows and Java trust
stores, and issues certificates signed by it.

The deployment runs the downloaded executable directly rather than putting it on `PATH`:

```text
D:\MyApp\logsheet-app-requirenment\mkcert\mkcert-v1.4.4-windows-amd64.exe
```

```cmd
cd D:\MyApp\logsheet-app-requirenment\mkcert
mkcert-v1.4.4-windows-amd64.exe -version
```

### Install the local CA

```cmd
mkcert-v1.4.4-windows-amd64.exe -install
```

Already done on this machine looks like this, and is fine:

```text
The local CA is already installed in the system trust store! 👍
The local CA is already installed in Java's trust store! 👍
```

### Find the CA, and know which half to hand out

```cmd
mkcert-v1.4.4-windows-amd64.exe -CAROOT
```

```text
C:\Users\Hadi\AppData\Local\mkcert
├── rootCA.pem        ← distribute this to tablets
└── rootCA-key.pem    ← NEVER distribute this
```

> **`rootCA-key.pem` is the CA's private key.** Anyone holding it can mint a certificate that
> every device trusting this CA will accept — for any hostname, including ones you do not own.
> It stays on the machine that issues certificates and goes nowhere else.

### Issue the server certificate

Issue it for **every name the tablets will type**, in one certificate. A certificate for the IP
alone is not valid for the DNS name, and Android refuses it with an error the operator cannot act
on.

```cmd
mkcert-v1.4.4-windows-amd64.exe pwa.hnp.com 192.168.1.101
```

```text
Created a new certificate valid for the following names:
 - "pwa.hnp.com"
 - "192.168.1.101"

pwa.hnp.com+1.pem
pwa.hnp.com+1-key.pem
```

The `+1` in the filename is mkcert counting the extra name; both entries are in the certificate's
SAN, which is the field browsers actually read.

### Put them where nginx expects

```text
D:\MyApp\nginx\ssl\
├── pwa.hnp.com+1.pem        (or renamed pwa.crt)
└── pwa.hnp.com+1-key.pem    (or renamed pwa.key)
```

Renaming to `pwa.crt` / `pwa.key` is only cosmetic — the contents are unchanged — but it keeps
`nginx.conf` stable when the certificate is reissued under a different name.

### Internal DNS

A certificate proves the name; it does not resolve it. For `https://pwa.hnp.com` to work at all,
internal DNS must map:

```text
pwa.hnp.com → 192.168.1.101
```

The two are independent, and the failure modes look different: a missing DNS record gives "site
cannot be reached", a missing SAN entry gives a certificate warning.

## Linux — openssl

No mkcert needed; the same result with a CA you make once and reuse.

```bash
sudo mkdir -p /etc/nginx/ssl/local && cd /etc/nginx/ssl/local

# 1. The CA — once per plant. Keep ca.key offline; it can mint any certificate.
openssl genrsa -out ca.key 4096
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -out ca.crt \
  -subj "/C=IR/O=Plant/CN=Plant Local CA"

# 2. The server key and request
openssl genrsa -out nginx.key 2048
openssl req -new -key nginx.key -out nginx.csr -subj "/C=IR/O=Plant/CN=192.168.1.4"

# 3. Subject Alternative Names. Not optional: since 2017 every browser IGNORES CN and reads
#    only SAN, so a certificate without this is rejected however correct it looks.
cat > nginx.ext <<'EOF'
subjectAltName = @alt
extendedKeyUsage = serverAuth
[alt]
IP.1  = 192.168.1.4
DNS.1 = plant-pwa.local
EOF

# 4. Sign. 825 days is the maximum browsers accept; longer is silently distrusted.
openssl x509 -req -in nginx.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out nginx.crt -days 825 -sha256 -extfile nginx.ext

sudo chmod 600 nginx.key ca.key
sudo chown root:root nginx.key ca.key
```

`ca.crt` is what goes on the tablets. `nginx.crt` + `nginx.key` are what nginx serves.

Check what you built before trusting it:

```bash
openssl x509 -in nginx.crt -noout -text | grep -A1 "Subject Alternative Name"
```

## Installing the CA on tablets

Do this once per device, before handing it out.

The file to transfer is the **CA**, never the server certificate and never a private key:

| Source | File | Note |
|---|---|---|
| Windows (mkcert) | `C:\Users\<you>\AppData\Local\mkcert\rootCA.pem` | Android often will not offer a `.pem` in the file picker — copy it as `rootCA.crt`. The contents are identical; only the extension changes |
| Linux (openssl) | `/etc/nginx/ssl/local/ca.crt` | Already in the right form |

1. Copy that file to the tablet.
2. **Settings → Security → Encryption & credentials → Install a certificate → CA certificate.**
   The exact wording varies by manufacturer and Android version.
3. Confirm the warning. Android will not let you install a CA without a screen lock — set a PIN
   first.
4. Restart Chrome.

> **Installing the wrong file is the usual cause of "I installed it and it still does not
> trust".** `192.168.1.101.pem` or `pwa.hnp.com+1.pem` is the *server* certificate; installing it
> as a CA achieves nothing. It has to be the root that signed it.

Android 11+ hides CA installation behind that path and shows a permanent "network may be
monitored" notice. That is expected, and it is the price of a private CA on a plant network.

> **A tablet without the CA gets an interstitial warning, and a service worker will not install
> behind one.** The app appears to work when the operator clicks through, then fails offline —
> the worst possible symptom, because it appears days later and looks unrelated.

## Renewal

A certificate has an expiry and the tablets will stop trusting it that morning, all at once.
Write the date down.

```bash
# Linux
openssl x509 -in /etc/nginx/ssl/local/nginx.crt -noout -enddate
```

```powershell
# Windows — mkcert issues shorter-lived leaf certificates than the openssl recipe above
certutil -dump "D:\MyApp\nginx\ssl\pwa.hnp.com+1.pem" | Select-String "NotAfter"
```

Re-issuing the **server** certificate from the same CA needs no change on the tablets: rerun the
`mkcert` command (or the openssl signing step), replace the two files in `ssl\`, test, and reload.

Replacing the **CA** means visiting every device again — which is why the openssl CA above is
valid for ten years, and why mkcert's CA is worth leaving installed rather than reinstalling.

---

# nginx as a service

## Linux — systemd

nginx installs its own unit; there is nothing to write.

```bash
sudo apt install nginx
sudo systemctl enable --now nginx
```

Site file — `server` blocks only. `sites-available/*` is included from **inside** the main
`http { … }` block, so `worker_processes`, `events` and `http` cannot appear there; nginx refuses
to load a file that contains them.

```nginx
# /etc/nginx/sites-available/offline-pwa
server {
    listen 80;
    server_name 192.168.1.4;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name 192.168.1.4;

    ssl_certificate     /etc/nginx/ssl/local/nginx.crt;
    ssl_certificate_key /etc/nginx/ssl/local/nginx.key;

    root  /var/www/offline-first-pwa/dist;
    index index.html;

    # A single attachment may be up to 25 MB (app.attachments.max-file-size-bytes). nginx's
    # default is 1 MB, and it rejects the rest with a 413 that the operator reads as "upload
    # failed" and nobody reads as a proxy limit. Only /api/ passes through here — the admin
    # panel's Excel import talks to 8081 directly and is bounded by its own multipart limit.
    client_max_body_size 32m;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8081/api/;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # A large attachment on plant Wi-Fi must not be cut off mid-request.
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # The service worker and its manifest must never be served from cache, or a tablet keeps
    # running the previous build for as long as its cached copy is considered fresh — and the
    # symptom is a device that is simply out of date, with nothing failing.
    location ~* (sw\.js|workbox-.*\.js|manifest\.webmanifest)$ {
        add_header Cache-Control "no-cache";
    }
}
```

```bash
sudo ln -sf /etc/nginx/sites-available/offline-pwa /etc/nginx/sites-enabled/offline-pwa
sudo nginx -t          # must pass
sudo systemctl reload nginx
```

**`nginx -t` before every reload.** A reload with a broken config leaves the previous one running,
so the change appears to have done nothing at all — which sends you looking in the wrong place.

## Windows — WinSW

nginx for Windows is a **console application, not a native service**: closing the window kills
it, and a reboot leaves the plant without a PWA. WinSW wraps it and registers it with the Service
Control Manager, in the same bundled mode the backend uses — a renamed WinSW executable with an
XML of the same base name beside it.

### What to expect from nginx on Windows

nginx's own documentation describes the Windows build as **beta**, with limitations that do not
exist on Linux:

- it uses `select()`/`poll()` rather than the scalable event mechanisms used on UNIX;
- several workers can be configured but **only one actually does work**;
- UDP — and therefore QUIC — is not supported.

For this deployment that is acceptable: a few dozen tablets on a plant LAN, serving static files
and proxying one API. For anything throughput-sensitive, Linux is the better host. Use the current
**mainline** Windows distribution, which carries the fixes for the Windows build.

### Layout

```text
D:\MyApp\nginx\
│
├── NginxService.exe     ← the renamed WinSW executable
├── NginxService.xml     ← the service definition
├── nginx.exe            ← nginx itself
│
├── conf\
│   ├── nginx.conf
│   └── mime.types
├── html\
│   └── offline-first-pwa\dist\
├── ssl\
│   ├── pwa.hnp.com+1.pem
│   └── pwa.hnp.com+1-key.pem
└── logs\
    ├── access.log, error.log                  ← nginx's own
    └── NginxService.out/.err/.wrapper.log     ← WinSW's capture
```

### The service definition

`NginxService.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<service>
    <id>Nginx</id>
    <name>NGINX</name>
    <description>NGINX Web Server and Reverse Proxy</description>

    <executable>D:\MyApp\nginx\nginx.exe</executable>
    <startarguments>-p D:/MyApp/nginx/ -c conf/nginx.conf</startarguments>

    <!-- Stopping goes through nginx itself, not through killing the process. -->
    <stopexecutable>D:\MyApp\nginx\nginx.exe</stopexecutable>
    <stoparguments>-p D:/MyApp/nginx/ -c conf/nginx.conf -s quit</stoparguments>

    <workingdirectory>D:\MyApp\nginx</workingdirectory>
    <startmode>Automatic</startmode>

    <logpath>D:\MyApp\nginx\logs</logpath>
    <log mode="roll-by-size">
        <!-- KB, so ~10 MB per file. These are WinSW's captures, not nginx's own logs. -->
        <sizeThreshold>10240</sizeThreshold>
        <keepFiles>10</keepFiles>
    </log>

    <onfailure action="restart" delay="10 sec"/>
    <onfailure action="restart" delay="30 sec"/>
    <onfailure action="restart" delay="60 sec"/>
    <resetfailure>1 hour</resetfailure>

    <!-- Longer than the backend's 30 s: a graceful quit waits for in-flight requests, and an
         attachment upload on plant Wi-Fi is exactly the request worth waiting for. -->
    <stoptimeout>60 sec</stoptimeout>
</service>
```

Three things in there are not interchangeable:

**`startarguments`, not `arguments`.** WinSW requires the `startarguments` form once
`stoparguments` is configured. Using `arguments` alongside `stoparguments` is a configuration
error, and the symptom is a service that will not start with an unhelpful wrapper message.

**`-s quit`, not `-s stop`.** `stop` is a fast shutdown that drops connections in flight; `quit`
is graceful and lets existing requests finish. For a reverse proxy carrying operators' uploads,
graceful is the only sensible default. nginx also requires the signal to be sent by the same user
that started it — which is satisfied here because WinSW launches both under the service account.

**`-p` and `-c` on both.** nginx resolves relative paths against its prefix, so start and stop must
name the *same* prefix and config or the stop command cannot find the running master's PID file
and the service hangs until `stoptimeout` expires.

### Validate before installing

```powershell
cd "D:\MyApp\nginx"
.\nginx.exe -v
.\nginx.exe -p D:/MyApp/nginx/ -c conf/nginx.conf -t
```

Only continue when the test passes. Installing a service around a config that does not parse just
moves the failure somewhere harder to read.

### Install

```powershell
# PowerShell as Administrator
cd "D:\MyApp\nginx"
.\NginxService.exe install
.\NginxService.exe start
.\NginxService.exe status
Get-Service -Name Nginx
```

### Commands

| Action | Command |
|---|---|
| Install / start / stop / restart / status | `.\NginxService.exe install \| start \| stop \| restart \| status` |
| Re-read the XML | `.\NginxService.exe refresh` |
| Uninstall (stop first) | `.\NginxService.exe stop` then `.\NginxService.exe uninstall` |
| Process tree | `.\NginxService.exe dev ps` |
| Force-terminate a wedged wrapper | `.\NginxService.exe dev kill` |
| Test config | `.\nginx.exe -p D:/MyApp/nginx/ -c conf/nginx.conf -t` |
| Graceful reload | `.\nginx.exe -p D:/MyApp/nginx/ -c conf/nginx.conf -s reload` |
| Graceful shutdown | `.\nginx.exe -p D:/MyApp/nginx/ -c conf/nginx.conf -s quit` |
| Reopen log files | `.\nginx.exe -p D:/MyApp/nginx/ -c conf/nginx.conf -s reopen` |
| Show processes | `tasklist /fi "imagename eq nginx.exe"` |

`.\NginxService.exe stop` invokes the `-s quit` above, so it is the graceful path — `dev kill` is
a fallback for a wrapper that has stopped responding, not a normal stop.

A healthy instance shows a **master and a worker** in `tasklist`.

### Changing the configuration

A `nginx.conf` edit does not need a service restart. Test, then reload:

```powershell
cd "D:\MyApp\nginx"
.\nginx.exe -p D:/MyApp/nginx/ -c conf/nginx.conf -t
.\nginx.exe -p D:/MyApp/nginx/ -c conf/nginx.conf -s reload
```

**Never reload without testing first.** A reload with an invalid config leaves the previous one
running, so the change appears to have done nothing — and you go looking in the wrong place.

### The whole `nginx.conf`

There are no `sites-available` / `sites-enabled` directories on Windows, so the top-level
directives are required — this **is** the main file, and `server { }` must sit inside `http { }`
or nginx reports `"server" directive is not allowed here`.

```nginx
worker_processes 1;

events {
    worker_connections 1024;
}

http {
    # Not optional. Without mime.types, Vite's module scripts are served as text/plain and the
    # browser refuses them: "Expected a JavaScript-or-Wasm module script but the server responded
    # with a MIME type of text/plain". The page loads and nothing runs.
    include       mime.types;
    default_type  application/octet-stream;

    server {
        listen 80;
        server_name pwa.hnp.com 192.168.1.101;
        return 301 https://$host$request_uri;
    }

    server {
        listen 443 ssl;
        server_name pwa.hnp.com 192.168.1.101;

        # Forward slashes, even on Windows — nginx documents this, and backslashes are read as
        # escapes.
        ssl_certificate     D:/MyApp/nginx/ssl/pwa.hnp.com+1.pem;
        ssl_certificate_key D:/MyApp/nginx/ssl/pwa.hnp.com+1-key.pem;

        root  D:/MyApp/nginx/html/offline-first-pwa/dist;
        index index.html;

        # See the Linux block above: 25 MB attachments against nginx's 1 MB default.
        client_max_body_size 32m;

        location / {
            try_files $uri $uri/ /index.html;
        }

        location /api/ {
            proxy_pass http://127.0.0.1:8081/api/;

            proxy_set_header Host              $host;
            proxy_set_header X-Real-IP         $remote_addr;
            proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;

            proxy_read_timeout 300s;
            proxy_send_timeout 300s;
        }

        location ~* (sw\.js|workbox-.*\.js|manifest\.webmanifest)$ {
            add_header Cache-Control "no-cache";
        }
    }
}
```

> **Watch the semicolons.** Every directive ends in `;`, and `#` runs to the end of the line — so
> a comment placed before the semicolon swallows it and `nginx -t` reports an unhelpful
> "unexpected end of file". Keep path comments on their own lines.

### Logs — four files, two owners

```powershell
cd "D:\MyApp\nginx"
Get-Content ".\logs\error.log" -Tail 100 -Wait                  # nginx itself
Get-Content ".\logs\NginxService.wrapper.log" -Tail 100         # WinSW: did it launch?
Get-Content ".\logs\NginxService.err.log" -Tail 100
```

When the service will not start, read the wrapper log first — it says whether nginx was launched
at all — and `error.log` second, which says why nginx refused. nginx's own logs are not rotated by
WinSW; plan that separately if access logging is left on.

### Updating nginx itself

```powershell
cd "D:\MyApp\nginx"
.\NginxService.exe stop
tasklist /fi "imagename eq nginx.exe"          # must be empty before replacing the binary

Copy-Item ".\nginx.exe" ".\nginx.exe.bak" -Force
Copy-Item ".\conf\nginx.conf" ".\conf\nginx.conf.bak" -Force
# replace the distribution files, keeping your conf\ and ssl\

.\nginx.exe -p D:/MyApp/nginx/ -c conf/nginx.conf -t
.\NginxService.exe start
```

### Windows firewall

```powershell
New-NetFirewallRule -DisplayName "PWA HTTPS 443" -Direction Inbound -LocalPort 443 `
  -Protocol TCP -Action Allow -Profile Domain,Private
New-NetFirewallRule -DisplayName "PWA HTTP redirect 80" -Direction Inbound -LocalPort 80 `
  -Protocol TCP -Action Allow -Profile Domain,Private
```

**Do not open 8081.** nginx reaches the backend over loopback; a tablet never should. Leaving
8081 open gives every device on the plant network a route that bypasses TLS.

---

## Publishing a new build

```bash
npm run build:mobile
```

```bash
# Linux
sudo rsync -a --delete dist/ /var/www/offline-first-pwa/dist/
```

```powershell
# Windows
robocopy .\dist "D:\MyApp\nginx\html\offline-first-pwa\dist" /MIR
```

No nginx reload is needed — these are static files.

Tablets pick the new build up through the service worker, which is configured to update itself
and take over immediately (`registerType: autoUpdate`, `skipWaiting`, `clientsClaim`). In practice
that means **the fleet updates within minutes of a deploy, without anyone touching a device** —
which is exactly why `sw.js` must never be cached, and why a bad build reaches everyone quickly.
Check one tablet before walking away.

> **A rollback is not symmetric with a deploy.** Reinstalling an older build on a tablet whose
> IndexedDB was written by a newer one leaves the app unable to open its database; it refuses to
> start rather than delete unsynced readings. See
> [docs/storage.md](storage.md#changing-the-schema).

---

## Verifying a deployment

From a tablet, not from the server — the server can reach things the tablet cannot.

1. `https://192.168.1.4` loads with **no certificate warning**. A warning means the CA is not
   installed, and the service worker will not register behind it.
2. Log in. A failure here with the page loading is usually the `/api/` proxy: check
   `proxy_pass` and that the backend answers on 8081.
3. **Settings → server URL** shows the same origin the browser is on.
4. Install the app (Chrome menu → *Add to Home screen*), then put the tablet in flight mode and
   open it. It must start, show cached work, and let an operator fill a sheet.
5. Scan a tag. Web NFC only exists in a secure context, so this failing while everything else
   works points straight back at TLS.
6. Come back online and confirm the queue drains.

```bash
# From the server, the two things worth checking directly
curl -k https://192.168.1.4/ -o /dev/null -w "%{http_code}\n"
curl -s http://127.0.0.1:8081/actuator/health/readiness
```

---

## When it does not work

| Symptom | Cause |
|---|---|
| Certificate warning on the tablet | CA not installed, or the certificate has no SAN for the address being typed |
| App loads, login fails | `/api/` proxy wrong, or the backend is down. `curl` the readiness probe |
| CORS errors in the console | The stored server URL is not the app's own origin, so requests are cross-origin. Same-origin needs no CORS at all |
| NFC scanning absent | Not a secure context. Check TLS, not the NFC code |
| Nothing works offline | The service worker never registered — again, usually the certificate |
| Tablets stuck on an old build | `sw.js` is being cached. Confirm the `Cache-Control: no-cache` location block |
| 413 on photo upload | `client_max_body_size` still at nginx's 1 MB default |
| nginx will not start on Windows | Read `logs\NginxService.wrapper.log` first (did WinSW launch it?), then `logs\error.log` (why did nginx refuse?) |
| `"server" directive is not allowed here` | A `server { }` block outside `http { }` in `nginx.conf` |
| JavaScript served as `text/plain`, page blank | `include mime.types;` missing from the `http` block, or `conf\mime.types` absent |
| Service stop hangs until the timeout | Start and stop use different `-p` / `-c`, so `-s quit` cannot find the running master |
| Config edited, nothing changed | A reload with an invalid config keeps the old one running. Always `nginx -t` first |

---

## Related

- [Backend deployment — the Java service, database, backups](../../../JavaProject/backend-offline-first/docs/deployment.md)
- [README § Production Deployment](../README.md#production-deployment)
- [docs/storage.md § Changing the schema](storage.md#changing-the-schema)
- [docs/device-features.md](device-features.md) — what each device capability needs
