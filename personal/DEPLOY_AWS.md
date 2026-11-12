# Deploying Boardle to AWS (profiles + per-player history)

`serve.py` is now a small Python server: it serves the static app **and** a JSON API
for sign-in and history. Locally it uses SQLite (`~/.boardle/boardle.sqlite3`). On AWS you
can keep SQLite on a single server, or switch to DynamoDB with one env var.

```
browser ──HTTPS──► (Lightsail/EC2 + Caddy)  or  (App Runner)  ──► serve.py ──► SQLite file | DynamoDB table
```

## API (same-origin, JSON)
| Method | Path | What |
|---|---|---|
| GET  | `/api/me` | `{server:true, user:{username}|null, registration, inviteRequired}` — the app uses this to detect server mode |
| POST | `/api/register` | `{username, password, invite?}` → 201 + session cookie |
| POST | `/api/login` | `{username, password}` → 200 + session cookie (10 failures / 15 min / IP+user → 429) |
| POST | `/api/logout` | ends the session |
| GET  | `/api/history` | `{data, rev, updatedAt}` — all of this player's `boardle:*` keys |
| PUT  | `/api/history` | `{data, baseRev}` → `{rev}`; 409 + server copy when another device wrote first (client merges and retries) |
| GET  | `/healthz` | `{ok:true}` for load balancer / App Runner health checks |

Security: passwords hashed with **scrypt** (N=16384, r=8, p=1, 16-byte random salt; PBKDF2-SHA256 600k
fallback). Sessions are random 256-bit tokens in an **HttpOnly, SameSite=Lax** cookie (`Secure` behind HTTPS);
only the SHA-256 of the token is stored. Writes require `Content-Type: application/json` and a same-origin
`Origin`. Backend code, tests, dotfiles and DB files are never served as static files.

## Environment variables
| Var | Default | Notes |
|---|---|---|
| `PORT` / `BOARDLE_PORT` | 8000 | `python3 serve.py 8080` also works |
| `BOARDLE_HOST` | all interfaces | set `127.0.0.1` when behind a local reverse proxy |
| `BOARDLE_STORAGE` | `sqlite` | `dynamodb` for AWS DynamoDB |
| `BOARDLE_DB_PATH` | `~/.boardle/boardle.sqlite3` | SQLite file (kept **outside** the app folder so upgrades don't touch it) |
| `BOARDLE_DDB_TABLE` | `boardle` | DynamoDB table name |
| `AWS_REGION` | — | e.g. `us-east-1` (credentials come from the instance/App Runner role) |
| `BOARDLE_DDB_ENDPOINT` | — | only for DynamoDB Local |
| `BOARDLE_ALLOW_REGISTER` | `1` | set `0` after creating your family's accounts |
| `BOARDLE_INVITE_CODE` | — | if set, required to create an account (recommended on the public internet) |
| `BOARDLE_COOKIE_SECURE` | `0` (Docker image: `1`) | force `Secure` cookies; also automatic when `X-Forwarded-Proto: https` |
| `BOARDLE_SESSION_DAYS` | 30 | sign-in lifetime |

## Option A (simplest, cheapest): Lightsail or EC2 + Caddy + SQLite
Good for a household / a few dozen players. ~US$5/month Lightsail instance.

1. Create an Ubuntu 24.04 Lightsail instance (or EC2 t4g.micro). Open ports 80 and 443. Point a DNS name
   (e.g. `boardle.example.com`) at its static IP.
2. Copy the app and create a service user:
   ```bash
   sudo useradd --system --create-home --home-dir /var/lib/boardle boardle
   sudo mkdir -p /opt/boardle && sudo rsync -a personal/ /opt/boardle/
   ```
3. systemd unit `/etc/systemd/system/boardle.service`:
   ```ini
   [Unit]
   Description=Boardle
   After=network.target
   [Service]
   User=boardle
   WorkingDirectory=/opt/boardle
   Environment=BOARDLE_HOST=127.0.0.1 BOARDLE_DB_PATH=/var/lib/boardle/boardle.sqlite3
   Environment=BOARDLE_COOKIE_SECURE=1 BOARDLE_INVITE_CODE=change-me
   ExecStart=/usr/bin/python3 serve.py 8000
   Restart=always
   [Install]
   WantedBy=multi-user.target
   ```
   `sudo systemctl enable --now boardle`
4. HTTPS with Caddy (automatic Let's Encrypt): `sudo apt install caddy`, then `/etc/caddy/Caddyfile`:
   ```
   boardle.example.com {
     reverse_proxy 127.0.0.1:8000
   }
   ```
   `sudo systemctl reload caddy`. Caddy sends `X-Forwarded-Proto: https`, so cookies are `Secure`.
5. Backups: enable Lightsail automatic snapshots, and/or a nightly cron copy:
   ```bash
   sqlite3 /var/lib/boardle/boardle.sqlite3 ".backup '/var/lib/boardle/backup-$(date +\%F).sqlite3'"
   aws s3 cp /var/lib/boardle/backup-$(date +%F).sqlite3 s3://YOUR-BUCKET/boardle/   # optional
   ```

## Option B (managed, no servers): App Runner + DynamoDB
1. **DynamoDB table** (on-demand):
   ```bash
   aws dynamodb create-table --table-name boardle \
     --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
     --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
     --billing-mode PAY_PER_REQUEST
   aws dynamodb update-time-to-live --table-name boardle \
     --time-to-live-specification Enabled=true,AttributeName=ttl
   aws dynamodb update-continuous-backups --table-name boardle \
     --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true
   ```
   Schema (single table):
   | pk | sk | attributes |
   |---|---|---|
   | `USER#<username>` | `PROFILE` | `pw_hash`, `created_at` |
   | `USER#<username>` | `HISTORY` | `data_z` (Binary: zlib-compressed JSON of all `boardle:*` keys), `rev` (N), `updated_at` |
   | `SESSION#<sha256(token)>` | `SESSION` | `username`, `expires_at`, `ttl` (TTL attribute → expired sessions auto-delete) |

   History writes are conditional on `rev` (optimistic locking). Compression keeps a heavy player's
   history far below DynamoDB's 400 KB item limit.
2. **Image**: build and push the included `Dockerfile` to ECR:
   ```bash
   aws ecr create-repository --repository-name boardle
   docker build --platform linux/amd64 -t boardle .
   docker tag boardle:latest <acct>.dkr.ecr.<region>.amazonaws.com/boardle:latest
   aws ecr get-login-password | docker login --username AWS --password-stdin <acct>.dkr.ecr.<region>.amazonaws.com
   docker push <acct>.dkr.ecr.<region>.amazonaws.com/boardle:latest
   ```
3. **App Runner service** from that image: port `8000`, health check path `/healthz`, env
   `BOARDLE_STORAGE=dynamodb`, `BOARDLE_DDB_TABLE=boardle`, `AWS_REGION=<region>`,
   `BOARDLE_INVITE_CODE=<secret>`. Attach an **instance role** with this policy:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
       "Resource": "arn:aws:dynamodb:<region>:<acct>:table/boardle"
     }]
   }
   ```
   App Runner gives you HTTPS on `*.awsapprunner.com` (custom domain optional).
4. Backups: point-in-time recovery (above) and/or `aws dynamodb create-backup --table-name boardle --backup-name boardle-$(date +%F)`.

(ECS Fargate, Elastic Beanstalk or EC2 with Docker work the same way: run the image, set the env vars,
grant the role. Don't run more than one container with **SQLite**; use DynamoDB for multiple instances.)

## Moving existing progress
* Each browser's pre-existing progress (Guest data) is merged into the **first** profile signed into on that
  browser — nothing is deleted locally.
* 👤 → **Export history (JSON)** downloads everything for the current player; **Import JSON** merges a file into
  the signed-in profile (or Guest). Use it to move from your laptop to the AWS site, or as a manual backup.

## Local check before deploying
```bash
python3 serve.py                                  # SQLite, http://localhost:8000
python3 -m unittest discover -s tests             # API tests (DynamoDB test runs if boto3+moto installed)
docker build -t boardle . && docker run --rm -p 8000:8000 boardle
```
