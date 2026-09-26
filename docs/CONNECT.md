# Connect OpenTakeoff to your AI

OpenTakeoff's MCP server, [`opentakeoff-mcp`](https://www.npmjs.com/package/opentakeoff-mcp),
gives an AI agent the real takeoff engine: load a plan set, set the scale, measure rooms,
derive base and transitions, and export the marked set. This page gets it into the app you
already use, then runs a first takeoff command on a real plan.

It runs **on your own computer**. The agent reads plan files from your disk and writes exports
back to it. Nothing is hosted, and there is no account to create.

| Your app | How | Needs |
|---|---|---|
| **Claude Code** (terminal) | one command | Node 20+ |
| **Codex CLI** (terminal) | one command | Node 20+ |
| **Cursor** and other MCP clients | a few lines of JSON | Node 20+ |
| **Claude Desktop** | download one file, double-click | nothing else |
| **claude.ai in a browser, the Claude mobile app, ChatGPT** | not supported yet ([why](#claudeai-the-claude-mobile-app-and-chatgpt)) | — |

Check your Node version with `node -v`. The terminal routes need 20 or newer; get it from
[nodejs.org](https://nodejs.org).

## Claude Code

```bash
claude mcp add --scope user opentakeoff -- npx -y opentakeoff-mcp
```

`--scope user` makes OpenTakeoff available in every folder. Leave it off to add it to the
current project only. Check it:

```bash
claude mcp list
```

```
opentakeoff: npx -y opentakeoff-mcp - ✔ Connected
```

## Codex CLI

```bash
codex mcp add opentakeoff -- npx -y opentakeoff-mcp
codex mcp list
```

Codex asks before running OpenTakeoff's tools; approve them as they come up.

## Cursor and other MCP clients

Any client that runs local ("stdio") MCP servers takes the same entry. In Cursor it goes in
`~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "opentakeoff": {
      "command": "npx",
      "args": ["-y", "opentakeoff-mcp"]
    }
  }
}
```

## Claude Desktop

1. Download **[opentakeoff-mcp.mcpb](https://github.com/Kentucky-ai/opentakeoff/releases/latest/download/opentakeoff-mcp.mcpb)**
   (this link always points at the newest release).
2. Double-click it. Claude Desktop opens an install prompt; confirm it.

The bundle carries its own dependencies, so no Node or npm install is needed. It leaves out
the optional native renderer on purpose: every measuring and export tool works, but
`view_sheet` cannot draw sheet images and says so when asked.

## claude.ai, the Claude mobile app, and ChatGPT

These apps run in Anthropic's and OpenAI's clouds, not on your computer. They can only reach
an MCP server at a public web address, and a server on the internet has to keep strangers
out and must not read files off the machine it runs on. OpenTakeoff doesn't ship that server
yet. Until it does, use Claude Desktop or a terminal agent above.

## Try it on a real plan

The repository's demo plan is a real public floor finish plan (VA St. Cloud, sheet AF101,
with its finish schedule on AF600). Download it into a folder:

```bash
curl -LO https://github.com/Kentucky-ai/opentakeoff/raw/main/demo/sample-finish-plan.pdf
```

Start your agent in that folder and ask:

> Using OpenTakeoff, load sample-finish-plan.pdf and tell me how many sheets it has, each
> sheet's number, and the detected scale.

You should get two sheets: **AF101** at **1/8" = 1'-0"** and **AF600** with no scale found.
A detected scale is not yet a set scale; setting it is the first step of every takeoff. From there, the [agent manual](AGENT_GUIDE.md) is how a full takeoff
runs, and [MCP.md](MCP.md) walks the whole tool surface.

## Good to know

- **Where your plans go.** The server reads and writes files on your computer only. What
  the agent reads back (text, quantities and, where rendering is available, sheet images)
  becomes part of your conversation with your AI provider, like anything else you share
  with it.
- **Updates.** `npx -y opentakeoff-mcp` runs the package from npm. To make sure you're on
  the newest release, use `opentakeoff-mcp@latest` in the command; to pin one, use a
  version, e.g. `opentakeoff-mcp@0.9.90`.
- **Staged tools.** Some clients cope better with a smaller tool list. Set
  `OPENTAKEOFF_MCP_STAGED_TOOLS=1` in the server's environment to start with the setup tools
  only; details in [`mcp/README.md`](../mcp/README.md#staged-tool-exposure-opt-in).
- **Building from source or running in Docker:** [`MCP.md`](MCP.md#setup) and
  [`mcp/README.md`](../mcp/README.md).
