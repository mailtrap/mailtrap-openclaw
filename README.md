# Mailtrap for OpenClaw

An [OpenClaw](https://openclaw.ai) plugin that gives your agent [Mailtrap](https://mailtrap.io): it can send email, use templates, manage contacts, and read Inbound and Sandbox inboxes. Since 0.2.0 people can also email the agent and get a reply (the [email channel](#email-channel)).

The package carries three things:

- **Skills.** An unmodified copy of [`mailtrap-skills`](https://github.com/mailtrap/mailtrap-skills) that teaches the agent how to use Mailtrap.
- **The Mailtrap MCP server.** [`mcp-mailtrap`](https://www.npmjs.com/package/mcp-mailtrap), pinned to an exact version and started over stdio. It provides the tools the agent calls.
- **The email channel.** People email a Mailtrap Inbound address; the agent replies in the same conversation. Reply-only, sender-checked, durable, with attachments.

Requires OpenClaw `2026.11.1` or newer and the Node.js versions it supports: `>=24.16.0 <25` or `>=26.1.0`.

## Install

```bash
openclaw plugins install clawhub:@mailtrap/openclaw
openclaw plugins enable mailtrap
openclaw gateway restart
```

In a terminal, `plugins install` asks `Proceed with installation? [y/N]` once. Non-interactive installs (scripts, Docker, CI) fail with `requires capability consent` unless you pass `--accept-capabilities`:

```bash
openclaw plugins install clawhub:@mailtrap/openclaw --accept-capabilities
```

ClawHub installs currently show a `provenance-invalid` trust warning (also in `openclaw plugins inspect` and `openclaw plugins doctor`). The plugin still loads and works.

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

## Email channel

The channel id is `mailtrap`. Someone emails your Inbound address, the agent answers that message with Mailtrap's `reply` call, and the follow-ups of the conversation stay in one OpenClaw session. The channel never starts a new thread, replies to all, or forwards.

### Set up (automatic part first)

1. Create an Inbound inbox in Mailtrap (hosted `...@inbound-mailtrap.io`, or a custom domain). Note its ID.
2. Add the channel to `openclaw.json`:

   ```json5
   {
     channels: {
       mailtrap: {
         apiToken: "...",            // the channel's own token, see "Token scope" below
         inboxId: 12345,
         allowFrom: ["you@example.com", "@yourcompany.com"],
         // from: "agent@mail.yourdomain.com",   // custom-domain inboxes only
       }
     }
   }
   ```

3. Restart the gateway: `openclaw gateway restart`. The channel polls the inbox every 30 seconds. Mail that was already in the inbox at the first start is ignored.
4. Optional, faster and lighter: receive by webhook. Expose the gateway over https (for example `cloudflared tunnel --url http://localhost:<port>`), put an account-level token in `MAILTRAP_API_TOKEN` and the account id in `MAILTRAP_ACCOUNT_ID`, then run:

   ```bash
   openclaw mailtrap webhook connect --url https://<your-public-host>
   openclaw mailtrap webhook disconnect     # back to polling
   ```

   `connect` creates the `inbound_receiving` webhook for your inbox (or updates the URL of the one it created), and stores the signing secret in the plugin's state store. The broad token is used once and not kept. With a webhook the channel still polls once at every gateway start (to catch mail that arrived while it was down) and every 10 minutes (to catch lost webhooks). Use `--account <id>` for a non-default account and `--replace` to take over an existing webhook whose secret is unknown.

### Manual setup, in full

| Setting (`channels.mailtrap`) | Meaning |
| --- | --- |
| `apiToken` | Token the channel uses to read and reply. Required. |
| `inboxId` | Inbound inbox ID. Required. |
| `allowFrom` | Exact addresses and `@domain` entries (that exact domain, not subdomains). **Default deny**: an empty list drops everything. |
| `from` | Reply From address. **Required** on a custom-domain inbox, on that domain. **Must be omitted** on a hosted inbox (Mailtrap rejects it). The inbox type is detected at start from the inbox address. |
| `mediaMaxMb` | Largest inbound attachment downloaded. Default 20. Bigger files are skipped and the agent is told. |
| `outboundMaxMb` | Largest attachment sent back, per file. Default 10. |
| `pollIntervalSec` | Poll interval without a webhook. Default 30, minimum 5. |
| `allowUnauthenticated` | **Testing only.** Turns the DKIM check off. The allowlist still applies. |
| `accounts.<id>` | More inboxes. Each account has its own token, inbox, allowlist, `from`, webhook, cursor and state. Only `mediaMaxMb`, `outboundMaxMb` and `pollIntervalSec` fall back to the top level. An empty id means `default`. |

Webhook by hand: create a webhook with `webhook_type: "inbound_receiving"`, `inbound_inbox_id` and the URL `https://<host>/mailtrap/webhook/<account id>`, then store its `signing_secret`. The CLI is the supported way to store it.

### Sender check

A message must pass both layers, or it is dropped and logged with a reason (no reply, no bounce):

1. **Allowlist.** Default deny.
2. **DKIM, verified by the plugin.** Mailtrap Inbound does not expose `Authentication-Results`, so the plugin downloads the raw message (the link expires after about an hour; it asks for a fresh one when needed) and verifies the DKIM signature itself with `mailauth`. It requires a passing signature whose domain is aligned (relaxed: same organizational domain) with the From domain, and a From that matches what the API reported. A forged `From` has no valid signature and is dropped.

Limits: DKIM proves the message was signed by the sender's domain, not that it is fresh; a signature that covers only part of the body (`l=` tag) is rejected, but a previously signed message that is replayed to your inbox still verifies. Senders on domains that do not sign with DKIM cannot be used.

### Reply-only and token scope

- The channel calls only `inbound.messages.reply`. It has no code path for reply-all, forward or new mail.
- On turns that came in by email, the agent cannot call the Mailtrap MCP tools that send, batch-send, forward or reply (`mailtrap__send-email`, `mailtrap__batch-send-*`, `mailtrap__reply-*`, `mailtrap__forward-*`, plus campaign start/schedule, forward rules and domain-setup emails). Reading, templates and Sandbox tools stay available. Email turns also cannot start sub-agents (`sessions_spawn`, `subagents`) or reach other sessions (`sessions_send`, `sessions_history`, `sessions_search`, `sessions_list`), so the main session, where the send tools are not guarded, is out of reach.
- How the deny works: a `before_tool_call` hook, not a tool-policy route (OpenClaw does not apply group tool policy to direct messages). It blocks when either match holds: the turn's session key is an email session key (`agent:<id>:mailtrap:...`), or the host's `ctx.requester.channel` is `mailtrap`. Tools are matched by normalized name (lower case, a leading `mcp__` and the `mailtrap__` server key stripped, `-` equal to `_`), so `mailtrap__send-email` (OpenClaw harness) and `mcp__mailtrap__send_email` (Codex harness) are the same rule. Under Codex the deny also covers `spawn_agent`, `send_input`, `send_message`, `followup_task`, `resume_agent`, `conversations_list`, `conversations_send`, `conversations_turn` and `sessions`. The `message` tool is the reply path and is never denied; on an email turn it may address only the current conversation (no routing fields, or this channel, account and sender), and `broadcast` or any other target is blocked. Codex's own code mode (`exec` running `tools.mcp__...`) calls tools inside the Codex app-server; each nested call reaches `before_tool_call` on its own and is checked like a direct call (confirmed on a live host).
- Email turns cannot run shell commands. A shell inherits the gateway's environment, including `MAILTRAP_API_TOKEN`, so a `curl` to the Send API would get around every tool rule. The hook blocks `exec`, `gateway_exec` and the Codex shell (`exec_command`, `shell`, `shell_command`, `local_shell`, `bash`) when the call carries a command, and `process`, `gateway_process` and `write_stdin` always. A Codex code-mode `exec` without a shell command is let through; its nested tool calls are checked one by one. Skills that run a script, such as `converting-email-templates`, therefore do not run on email turns. Email turns also cannot use OpenClaw's control-plane tools: `cron` (a scheduled job would run later outside the email session), `gateway`, `openclaw` (config and lifecycle changes) and `nodes`.
- The deny list is a guard on tool calls, not a sandbox. For an agent that answers email from people you don't fully trust, also run it with exec approvals or in a sandbox, and keep the broad `MAILTRAP_API_TOKEN` out of its environment if it doesn't need the MCP server (see OpenClaw's tool permissions docs).
- **Token scope.** A Mailtrap API token can be scoped to one Inbound folder (resource `inbound_folder`). Reading needs viewer and replying needs admin, so give the channel's `apiToken` admin on the folder that holds the inbox, and nothing else. Such a token cannot use the Send API, Sandbox, templates or other folders, which limits the damage if it leaks (it is a plain string in `openclaw.json`). It does not limit who a reply or forward goes to, and it is no layer against prompt injection: the channel token is used only by plugin code, while the agent's tools run on the MCP server's `MAILTRAP_API_TOKEN`. The `before_tool_call` deny above is the guard against that.

### Crash safety, sessions and attachments

- Every message ID is written to a durable ledger first. Before a reply is sent the item is marked `sending`; after a restart the plugin checks the inbound message's thread for an outbound reply and does not send twice. If the thread cannot be read it resends, which can in rare cases duplicate a reply but never loses one. An item left mid-turn is re-run under a fresh dispatch id (`<messageId>:retry-<n>`): OpenClaw drops a dispatch whose message id it already admitted (`skipped:duplicate`), also across a restart, and its own restart recovery finishes the interrupted turn into a delivery callback that died with the old process; the fresh id makes the re-run produce the one reply. The recovered turn may add an extra turn to the session transcript. When OpenClaw's restart recovery is still running the session, the re-run's dispatch returns with no agent run and no payloads (the turn is queued behind the recovery); the plugin does not treat that as "no reply": it retries later under a new dispatch id (60 s, doubling up to 5 min, for at most 45 min), so the one reply is sent once the session is free. These busy retries do not count against the three tries a failing turn gets; only after 45 min of a busy session is the item marked `failed`. An item is dropped as `no-reply` only when OpenClaw reports a run that finished (terminal outcome) before the dispatch returned and it produced nothing; a run that started or a queued follow-up that was admitted without a terminal outcome is retried the same way. Ledger entries expire after about a week.
- One OpenClaw session per conversation. The agent id comes from OpenClaw's routing on your config, which is left untouched. The session key is always built with `per-account-channel-peer`, whatever `session.dmScope` says (the default `main` would merge email into your main session), and honours `session.identityLinks`: `agent:<agent>:mailtrap:<account>:direct:<sender>:thread:<conversation>`. A reply from the sender joins the session through `In-Reply-To`/`References` (Mailtrap gives such a reply a new `thread_id`).
- Recovery matches a reply to its message by `in_reply_to`, so two messages in one thread each get their own reply. A reply too large for OpenClaw's 1 MiB store value limit is not sent and the item is marked `failed` (`reply-too-large`); the agent turn is not rerun.
- Attachments in: downloaded into OpenClaw's media store at once. Attachments out: the paths in the agent's reply (`mediaUrls`/`mediaUrl`) are attached only when their real path (symlinks and `..` resolved) is inside OpenClaw's media directory, and each file is capped by `outboundMaxMb`. A file named in both `mediaUrls` and `mediaUrl`, or reached through two paths, is attached once; the recipient sees the name without the media store's `---<uuid>` suffix (`summary.txt`), and the content type comes from the extension (`application/octet-stream` only for an unknown one); anything else is left off and named in the reply text.

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
| `npm test` | Channel, manifest, skills, packaging and launcher tests. No network. |
| `npm run skills:check` | Verify `skills/` against the pin. |
| `npm run pack:verify` | Pack the tarball and check its contents and size. |
| `npm run gate` | The whole release gate, ending with the ClawHub dry run. |

## Releasing

Bump `version` in both `package.json` and `openclaw.plugin.json` in the PR. When the PR is merged to `main`, [`publish.yml`](.github/workflows/publish.yml) checks whether that version is on ClawHub. If not, it runs `npm run gate` and publishes the gate's tarball, waiting for ClawHub's security scan; a failed scan fails the job. A merge without a bump publishes nothing. ClawHub rejects a version that already exists.

It publishes the tarball, not the folder: publishing a folder runs `npm pack --ignore-scripts`, which skips `prepack` and ships no `dist/`.

The workflow needs a ClawHub API token for the `mailtrap` owner, stored as the `CLAWHUB_TOKEN` secret in the GitHub environment `clawhub`. Ideally the environment has a required reviewer, so each publish waits for approval.

## License

MIT. See [LICENSE](LICENSE).
