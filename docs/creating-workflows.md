# Creating Workflows — Instruction Set

**AI agents: Read this resource (`orchestrator://workflow-guide`) before creating, editing, or debugging workflows.** It explains placeholder syntax (including when to use regex vs JSON path), how to inspect step output, and common pitfalls with real examples.

---

A workflow chains tools across MCPs. This guide explains how to create workflows and how to test them before committing.

## What Workflows Can Do

- **Chain MCPs** — Step 1 runs a Spotify tool, step 2 uses that output in a Pieces or filesystem tool
- **Inject previous output** — Use `{{step0}}`, `{{step1.id}}`, `{{step1.playlists[1].id}}` to pass data between steps
- **Accept input** — Use `{{input.subject}}` for values passed when running via `run_workflow(name, input)`
- **Use dates and IDs** — `{{date.isoDate}}`, `{{date.now}}`, `{{uuid}}` for timestamps, slugs
- **Run manually or on schedule** — Trigger: `manual` or `schedule` (cron)

## Manual Run & Seeing Output

### 1. Use the Web UI (recommended for authoring)

1. Open the **Workflows** tab
2. Add or edit a workflow
3. Each step has a **Test** button — run that step alone to see its raw output
4. Test output appears under the step; use it to design the next step’s args
5. Use **Run** to execute the whole workflow and see combined output
6. Use the **Preview** toggle on args to see placeholder substitution before running

### 2. Use the MCP directly

- **`call_tool(mcp, tool, args)`** — Run a single tool to inspect output
- **`spotify__call(tool, args)`** or **`mcpName__call(tool, args)`** — Same, via gateway
- **`run_workflow(name, input?)`** — Run the full workflow and get the last step’s output
- **`list_tools(mcp="spotify")`** — Discover tool names and schemas

### 3. Iterate and validate

- Run earlier steps first, inspect JSON/text output
- Design placeholders from real output (e.g. `{{step1.playlists[1].id}}`)
- Add the next step, test it, repeat

## Placeholder Reference

| Placeholder | Use |
|-------------|-----|
| `{{step0}}` | Full text output of step 0 |
| `{{step1.id}}` | JSON path — dot notation |
| `{{step1.playlists[1].id}}` | Nested path with array index |
| `{{step1:regex:Playlist ID: (\w+)}}` | Regex — first capture group |
| `{{step0:regexAll:ID: ([A-Za-z0-9]+):array}}` | Regex all captures as array |
| `{{input.subject}}` | From `run_workflow(name, { subject: "math" })` |
| `{{date.isoDate}}` | YYYY-MM-DD |
| `{{date.now}}` | Full ISO datetime |
| `{{date.isoTime}}` | HH:mm:ss.sss |
| `{{uuid}}` | Random UUID |
| `{{js: new Date().toISOString() }}` | Arbitrary JavaScript |

## What to Accommodate

- **JSON vs plain text** — If a step returns JSON, use `{{stepN.path}}`; if plain text, use `{{stepN}}` or regex
- **Array indexing** — Use `{{step0.items[0].id}}` for the first item’s id
- **Optional input** — If the workflow uses `{{input.x}}`, pass `input` when calling `run_workflow`
- **MCP availability** — Ensure required MCPs are enabled before running
- **Tool schemas** — Use `list_tools` to see required/optional args

## Workflow Structure

```json
{
  "name": "My Workflow",
  "description": "What it does",
  "trigger": "manual",
  "steps": [
    { "mcp": "spotify", "tool": "searchPlaylists", "args": { "query": "focus" } },
    {
      "mcp": "spotify",
      "tool": "playMusic",
      "args": {
        "uri": "{{step0.playlists[0].uri}}"
      }
    }
  ]
}
```

- **trigger**: `manual` or `schedule`
- **schedule**: Cron expression if `trigger` is `schedule` (e.g. `*/30 * * * *` = every 30 min)
- **steps**: Array of `{ mcp, tool, args? }` — args can use placeholders

## Tips

1. **Start with one step** — Run it, inspect output, then add the next
2. **Use Test per step** — Don’t run the whole workflow until each step works
3. **Check the glossary** — `orchestrator://glossary` has the full placeholder list
4. **Use `list_tools`** — Discover tool names and arg schemas before wiring args

## Troubleshooting: Start Study Session Case Study

This section documents the thought process used to fix a broken workflow, so future AI agents can apply the same reasoning.

**Problem:** The Start Study Session workflow failed on step 2 (`playMusic`). The step used `{{step0.playlists[0].id}}` to pass the first playlist ID from the search result.

**Root cause:** The placeholder `{{step0.playlists[0].id}}` assumes `step0` is a JSON object with structure `{ playlists: [{ id: "..." }] }`. In reality, MCP tools return their result via `extractTextContent`, which yields **plain text**. The Spotify `searchSpotify` tool returns formatted text like:

```
# Search results for "math study" (type: playlist)

1. "Math Study" (No description tracks) by User - ID: abc123xyz
2. ...
```

So `step0` is a string, not JSON. `JSON.parse(step0)` fails, and the path `playlists[0].id` returns nothing.

**Fix:** Use regex extraction instead of JSON path. The workflow was changed from:
- `{{step0.playlists[0].id}}` ❌
- `{{step0:regex:ID: ([A-Za-z0-9]+)}}` ✅

The regex captures the first ID from the text output (the part after `ID: `). This matches the pattern used in other workflows like Like & Archive (`{{step1:regex:Playlist ID: ([^\\s\\n]+)}}`).

**Takeaway:** Before using `{{stepN.path}}`, verify that step N actually returns JSON. Run the step with `call_tool` or the UI Test button and inspect the raw output. If it's plain text (e.g. markdown, line-based results), use `{{stepN}}` for the full string or `{{stepN:regex:pattern}}` to extract specific values.
