import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// OpenClaw refuses to install a package without `openclaw.extensions`, so this
// entry exists only to satisfy that rule. The skills and the Mailtrap MCP
// server are declared in openclaw.plugin.json; nothing is registered here.
export default definePluginEntry({
  id: "mailtrap",
  name: "Mailtrap",
  description:
    "Mailtrap skills and MCP server: send email, use templates, manage contacts, read Inbound and Sandbox inboxes.",
  register() {}
});
