# Optional Laya CPU decision service

Compose profile **`laya`** is **off by default**. A plain `docker compose up`, `--profile full`, and `--profile harness` do not start it. Boot on the VPS (`COMPOSE_PROFILES=harness,orchestrator`) does not start it either.

The service is a loopback stand-in for [Laya](https://github.com/NandhaKishorM/laya) `laya-serve`: the Jev-compatible `POST /v1/systemone` decision API, on CPU, for when TypeSafe hosted Jev is unavailable. Upstream publishes **no registry image** (the CPU quickstart builds a local image from that repo). This profile therefore runs `deploy/laya/stub_server.py` on `python:3.12-slim`. It does not download checkpoints and it does not invent an API key.

## Enable

From the repo root:

```bash
docker compose --profile laya up -d laya
docker compose --profile laya ps
curl -fsS http://127.0.0.1:8000/health
```

`up -d --wait laya` returns when the healthcheck passes. Stop with:

```bash
docker compose --profile laya stop laya
```

Point Hop 2 at it only when you want that plugin. The loader still fails closed if `OPTIO_NEW_JEV_ROUTER` is unset; the default in `.env.example` stays `rules`.

```bash
# host process (plugin default is already this URL)
OPTIO_NEW_JEV_ROUTER=laya
OPTIO_NEW_LAYA_URL=http://127.0.0.1:8000
```

Another container on the Compose network uses `http://laya:8000` instead of loopback.

## Healthcheck

| Probe                          | Path           | Auth |
| ------------------------------ | -------------- | ---- |
| Compose healthcheck and `curl` | `GET /health`  | none |
| Alias                          | `GET /healthz` | none |

Inside the container the check is:

```text
python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)"
```

Interval 30s, timeout 5s, 3 retries, `start_period` 10s. A healthy body has `"status": "ok"`, `"device": "cpu"`, `"engine": "placeholder"`, and `"nvidia_required": false`.

`POST /v1/systemone` accepts the same JSON body as the `laya` JevRouter plugin (`state` + `questions.hop2`). The placeholder always returns `answers.hop2.choice = "deny"` with `"placeholder": true`, so Hop 2 fails closed (`reason: "systemone"`) and does not select a paid upstream. Replace the server before expecting a real route.

## Environment

Set these in `.env` (gitignored) or the shell. `.env.example` has the non-secret defaults. Do not commit `LAYA_API_KEY`.

| Variable                   | Default                   | Where it applies                                                                                                    |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `OPTIO_NEW_LAYA_URL`       | `http://127.0.0.1:8000`   | JevRouter `laya` plugin (`LAYA_URL` is the alias)                                                                   |
| `OPTIO_NEW_LAYA_HOST_PORT` | `8000`                    | Host port published on `127.0.0.1` only                                                                             |
| `LAYA_DEVICE`              | `cpu`                     | Documented for operators. The Compose service **pins** `LAYA_DEVICE=cpu` and ignores a host value of `cuda`         |
| `LAYA_PRELOAD`             | `0`                       | Passed through. The placeholder does not load weights. Real `laya-serve` should use `1` once checkpoints are cached |
| `LAYA_THREADS`             | `4`                       | Passed through. Cap at the physical core count on a real CPU server                                                 |
| `LAYA_MODEL`               | unset                     | Plugin only. Omitted from the JSON body unless set, so real `laya-serve` can auto-select a checkpoint               |
| `LAYA_API_KEY`             | unset                     | When set on the container, `POST /v1/systemone` requires `Authorization: Bearer`. `/health` stays open              |
| `OPTIO_NEW_LAYA_API_KEY`   | unset                     | Plugin bearer (`LAYA_API_KEY` is the alias). Match the container key if you set one                                 |
| `OPTIO_NEW_JEV_ROUTER`     | `rules` in `.env.example` | Set to `laya` to select this plugin                                                                                 |

Container bind is `0.0.0.0:8000`. The published host address is loopback. No public firewall hole for port 8000 (see [deploy/README.md](../deploy/README.md)).

## NVIDIA

This profile runs with CPU only. It has no NVIDIA driver requirement, no NVIDIA Container Toolkit requirement, and no `deploy.resources.reservations.devices` GPU block.

Upstream CUDA (`compose.cuda.yaml` in the Laya repo) is a separate build and is out of scope here.

## Swap in real `laya-serve`

Build that image from the upstream checkout. Public checkpoints need no Hugging Face token. Keep any `HF_TOKEN` or `LAYA_API_KEY` on the host, not in git.

```bash
git clone https://github.com/NandhaKishorM/laya.git
cd laya
docker compose -f compose.yaml -f compose.http.yaml up --build laya-serve
curl -fsS http://127.0.0.1:8000/health
```

That stack is CPU by default (`LAYA_DEVICE=cpu`) and also has a `/health` check. Point `OPTIO_NEW_LAYA_URL` at it and set `OPTIO_NEW_JEV_ROUTER=laya`. Stop this repo's placeholder first if both want host port 8000.
