# OpenTakeoff knowledge index

Read the page that answers the current question. Agents can read this index at
`takeoff://wiki` and individual pages at `takeoff://wiki/{page}` without loading
a plan. These are documentation resources, not additional measurement tools.

| Question | Page | MCP resource |
|---|---|---|
| What works, what is draft, and what is unsupported? | [Capability status](status.md) | `takeoff://wiki/status` |
| How do the browser, MCP and shared engine fit together? | [Architecture](architecture.md) | `takeoff://wiki/architecture` |
| What does a saved takeoff mean? | [Protocol](protocol.md) | `takeoff://wiki/protocol` |
| How do I measure, stitch, review and hand off work? | [Workflows](workflows.md) | `takeoff://wiki/workflows` |
| Which tool should I call, and in which coordinate frame? | [MCP routing](mcp.md) | `takeoff://wiki/mcp` |
| What do floor SF, wall SF, base LF and review mean? | [Domain knowledge](domain.md) | `takeoff://wiki/domain` |
| How do I change this repository and verify a PR? | [Repository guide](repo-guide.md) | `takeoff://wiki/repo-guide` |
| What tools and required inputs does the runtime expose? | [Generated tool index](../MCP_TOOL_INDEX.md) | `takeoff://wiki/tool-index` |

For detailed canvas instructions, use the [human guide](../USER_GUIDE.md).
For a full takeoff session, use the [agent guide](../AGENT_GUIDE.md).
The wiki routes to their detailed procedures rather than copying every control
and schema into every page.

The MCP build embeds these pages. CI checks the embedded copy, tool inventory,
schema references and documentation links against their sources. Reading a
resource does not mutate a session, set scale, review work or grant approval.
