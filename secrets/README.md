# secrets

Kit-harness (`/opt/optio-new`) uses **sops + age**. The runbook is [docs/secrets.md](../docs/secrets.md).

Plaintext `.env`, the age private key, `secrets/.sops.yaml`, and `secrets/optio-new.env` stay on the host. Git keeps this example and `.sops.yaml.example` only.

```bash
bash scripts/secrets.sh init
bash scripts/secrets.sh encrypt    # reads the existing .env
bash scripts/secrets.sh check
bash scripts/secrets.sh compose up -d
```

Infisical is an optional later swap with the same key names. It is not installed on this VPS.
