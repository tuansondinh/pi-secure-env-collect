# pi-secure-env-collect

Adds `secure_env_collect` tool to Pi.

Collects secrets through masked interactive UI, then writes them to:
- `.env`
- Vercel
- Convex

Tool output reports only key names and applied/skipped status. Secret values are not echoed in tool output.

## Install

```bash
pi install npm:pi-secure-env-collect
```

Local:

```bash
pi install /absolute/path/to/packages/pi-secure-env-collect
```

## Tool

- `secure_env_collect`

## Parameters

- `destination`: `dotenv` | `vercel` | `convex`
- `keys`: array of `{ key, hint?, required?, guidance? }`
- `envFilePath`: optional custom `.env` path
- `environment`: `development` | `preview` | `production` for Vercel

## Notes

- interactive UI required
- values are masked during entry
- collected values are hydrated into `process.env`
- Vercel/Convex application uses temp files to avoid putting raw secret values directly in shell command strings
