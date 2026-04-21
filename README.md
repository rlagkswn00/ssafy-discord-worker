# ssafy-discord-worker

Cloudflare Worker based Discord automation code for two separate workflows:

- `discord-mail-cs`: sends the next frontend/backend mail content to Discord on a schedule
- `discord-mm-integration`: relays Mattermost messages and attachments to Discord using a single JSON secret

## Repository Layout

```text
.
├── discord-mail-cs/
│   ├── mail-cs.js
│   ├── wrangler.jsonc
│   └── .dev.vars.example
├── discord-mm-integration/
│   ├── integration.js
│   ├── config.example.json
│   └── .dev.vars.example
└── .gitignore
```

## Security Rules

- Do not commit real webhook URLs, passwords, or Mattermost source tokens.
- Keep local secrets in ignored files such as `.dev.vars` or `discord-mm-integration/config.json`.
- Start from the example files in this repository and replace placeholder values locally.

## `discord-mail-cs`

This worker posts the next content item from the Maeil Mail repository to Discord.

### Required secrets

Copy `discord-mail-cs/.dev.vars.example` to `discord-mail-cs/.dev.vars` and replace the placeholders.

Required variables:

- `DISCORD_WEBHOOK_FRONTEND`
- `DISCORD_WEBHOOK_BACKEND`

The KV namespace binding name is `MAEIL_KV`, and the worker entry file is `mail-cs.js`.

### Local usage example

```bash
cd discord-mail-cs
cp .dev.vars.example .dev.vars
# fill in real webhook URLs
```

Then run the worker with your normal Wrangler workflow.

## `discord-mm-integration`

This worker receives Mattermost webhook payloads and forwards them to Discord.

### Required secret

The runtime expects a single environment variable:

- `MM_CONFIG`: JSON string containing Discord webhooks, source token mapping, and Mattermost login settings

### Prepare local config

1. Copy `discord-mm-integration/config.example.json` to `discord-mm-integration/config.json`
2. Replace all placeholder values with real values
3. Copy `discord-mm-integration/.dev.vars.example` to `discord-mm-integration/.dev.vars`
4. Convert the JSON to a single-line string and set it as `MM_CONFIG`

Example using `jq`:

```bash
cd discord-mm-integration
cp config.example.json config.json
cp .dev.vars.example .dev.vars
jq -c . config.json
```

Paste the `jq -c` output into the `MM_CONFIG=` line in `.dev.vars`.

If you deploy with Wrangler secrets instead of `.dev.vars`, store the same single-line JSON as the `MM_CONFIG` secret.

## Git-safe workflow

- Real secrets stay local only.
- Example files are committed.
- `.omx/`, `.dev.vars`, `.env*`, logs, and `discord-mm-integration/config.json` are ignored by Git.

## Initial Git setup

```bash
git init
git branch -M main
git remote add origin https://github.com/rlagkswn00/ssafy-discord-worker.git
```

After secret values are confirmed to be excluded, commit and push `main`.
