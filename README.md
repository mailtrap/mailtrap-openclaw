# Mailtrap for OpenClaw

An [OpenClaw](https://openclaw.ai) plugin that gives your agent [Mailtrap](https://mailtrap.io): it can send email, use templates, manage contacts, and read Inbound and Sandbox inboxes.

The package carries two things:

- **Skills.** An unmodified copy of [`mailtrap-skills`](https://github.com/mailtrap/mailtrap-skills) that teaches the agent how to use Mailtrap.
- **The Mailtrap MCP server.** [`mcp-mailtrap`](https://www.npmjs.com/package/mcp-mailtrap), pinned to an exact version and started over stdio. It provides the tools the agent calls.

Requires OpenClaw `2026.11.1` or newer and the Node.js versions it supports: `>=24.16.0 <25` or `>=26.1.0`.

## Install

```bash
openclaw plugins install clawhub:@mailtrap/openclaw
openclaw plugins enable mailtrap
openclaw gateway restart
```

## Credentials

The plugin embeds no credentials. OpenClaw starts the MCP server with a minimal environment (`HOME`, `PATH`, `USER` and a few more), so the gateway's own `MAILTRAP_*` variables do **not** reach it. Instead, the plugin's launcher reads `~/.openclaw/.env` and copies only `MAILTRAP_API_TOKEN`, `MAILTRAP_ACCOUNT_ID` and `MAILTRAP_SANDBOX_ID` into the server's environment. No other key in that file reaches the server. A value already present in the server's environment wins over the file.

1. Put the secrets in `~/.openclaw/.env`:

   ```bash
   MAILTRAP_API_TOKEN=...
   MAILTRAP_ACCOUNT_ID=...
   # optional: the default Sandbox inbox
   MAILTRAP_SANDBOX_ID=...
   ```

2. Restart the gateway: `openclaw gateway restart`.

### Fallback: `mcp.servers.mailtrap`

The launcher reads only `~/.openclaw/.env`, resolved from the server's `HOME`. If you set a custom `OPENCLAW_STATE_DIR` or `OPENCLAW_HOME`, OpenClaw's own `.env` lives elsewhere and the launcher does not see it. Pass the variables through an `mcp.servers.mailtrap` entry in `openclaw.json` instead. An operator entry replaces the plugin's default entry of the same name, so it restates `command`, `args` and `cwd`.

- **Where the secrets go.** `${VAR}` in `env` is expanded from OpenClaw's own environment, which includes the `.env` of the active state dir. Put the secrets in `$OPENCLAW_STATE_DIR/.env` (with `OPENCLAW_HOME`, that is `$OPENCLAW_HOME/.openclaw/.env`; the `OPENCLAW_HOME` path is not tested here), or in the gateway's own environment. Don't leave them only in `~/.openclaw/.env`: the `${VAR}` entries below would not resolve, and their literal text would beat the launcher's copy.
- **Unresolved values fail silently.** A `${VAR}` that does not resolve reaches the server as the literal text `${VAR}`, for every key, and it beats the real value in the launcher's `.env`. `mcp doctor --probe` still prints `ok`, so check that the variables are set before you rely on it.
- **`<install dir>` must be an absolute path.** Take it from `openclaw plugins inspect mailtrap` and expand any `~` or `$OPENCLAW_HOME` by hand. OpenClaw does not expand them, and such a path fails with `stdio cwd does not exist`.
- **Keep `cwd` at the install dir.** `mcp-mailtrap` also loads a `.env` from its working directory, with every key in it. A `cwd` pointing at your state dir would hand all of that file's secrets to the server.

```json5
{
  mcp: {
    servers: {
      mailtrap: {
        command: "node",
        args: ["<install dir>/bin/mailtrap-mcp.mjs"],
        cwd: "<install dir>",
        env: {
          MAILTRAP_API_TOKEN: "${MAILTRAP_API_TOKEN}",
          MAILTRAP_ACCOUNT_ID: "${MAILTRAP_ACCOUNT_ID}",
          // only if you set it; an unset ${VAR} reaches the server as the literal text "${VAR}"
          // MAILTRAP_SANDBOX_ID: "${MAILTRAP_SANDBOX_ID}"
        }
      }
    }
  }
}
```

Which variables are needed:

| Variable | Needed for |
| --- | --- |
| `MAILTRAP_API_TOKEN` | Everything. Required. |
| `MAILTRAP_ACCOUNT_ID` | Templates, Sandbox list and show, logs, domains, suppressions. |
| `MAILTRAP_SANDBOX_ID` | Default Sandbox inbox for the Sandbox tools. |

To turn the MCP server off and keep the skills, set `mcp.servers.mailtrap.enabled` to `false`.

## Verify

```bash
openclaw plugins inspect mailtrap --runtime
openclaw skills list
openclaw mcp doctor mailtrap --probe
```

- `plugins inspect mailtrap --runtime` shows `Status: loaded` and lists the `mailtrap` MCP server under `MCP servers`. It does not list the skills.
- `skills list` shows the eight skills below with status `ready`.
- `mcp doctor mailtrap --probe` connects to the server and prints only a status line, `- mailtrap: ok`, never the tool list or any credential. It checks `mcp.servers` entries in `openclaw.json` only, so it finds `mailtrap` when you use the fallback above and reports `No MCP server named "mailtrap"` otherwise. `ok` means the server started, not that the credentials arrived. The real proof is an agent turn that calls a Mailtrap tool, for example "list my Mailtrap sandboxes".

## Included skills

| Skill | Purpose |
| --- | --- |
| `authorizing-api-requests` | API tokens and request authorization |
| `converting-email-templates` | Turn HTML into Mailtrap-ready templates |
| `managing-contacts` | Contacts and lists |
| `receiving-emails` | Inbound inboxes and messages |
| `sending-emails` | Transactional and bulk sending |
| `setting-up-sending-domain` | Domain verification |
| `testing-with-sandbox` | Sandbox inboxes |
| `using-email-templates` | Sending with templates |

## Updating skills

`skills/` is a committed copy of `mailtrap-skills/skills/` at the commit pinned in `skills-source.json`. Never edit files under `skills/` by hand. If a skill is wrong, fix it upstream in `mailtrap-skills`, then:

```bash
# set "commit" in skills-source.json to the new upstream SHA
npm run skills:sync    # replaces skills/ with the pinned copy
npm run skills:check   # exits 1 if skills/ differs from the pin (CI runs this)
```

## Develop

```bash
npm install
npm run build
openclaw plugins install --link .
openclaw plugins enable mailtrap
```

Checks:

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type-check `src/`. |
| `npm test` | Manifest, skills, packaging and launcher tests. |
| `npm run skills:check` | Verify `skills/` against the pin. |
| `npm run pack:verify` | Pack the tarball and check its contents and size. |
| `npm run gate` | The whole release gate, ending with the ClawHub dry run. |

## Releasing

Publish the tarball, not the folder. Publishing a folder runs `npm pack --ignore-scripts`, which skips `prepack` and ships no `dist/`.

```bash
npm run gate
clawhub package publish ./mailtrap-openclaw-0.1.0.tgz --family code-plugin \
  --owner mailtrap --source-repo mailtrap/mailtrap-openclaw \
  --source-commit <sha> --source-ref main --wait
```

## License

MIT. See [LICENSE](LICENSE).
