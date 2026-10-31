# @pipeworx/chrome-web-store

Chrome Web Store listing data: one extension by id, free-text search, and
extensions attributed to one publisher — name, rating, user count, version,
last-updated date, category and website for each.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1863+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `chrome_web_store_extension(id)` — full listing for one extension by its
  32-character id: name, publisher, rating, rating count, user count,
  version, last-updated date, category, website, size, languages.
- `chrome_web_store_search(query, limit?)` — free-text search; matching
  extensions with id, name, rating, rating count, user count, category,
  website. A product-led-growth / adoption signal — what people are actually
  installing.
- `chrome_web_store_by_publisher(publisher, max_checked?)` — extensions
  attributed to one publisher name, confirmed against each candidate's own
  listing. See "Known limits" below — this is bounded, not exhaustive.

## Auth

Keyless. No login, no API key — this reads the same public pages a browser
does.

## Data sources

- Google, Chrome Web Store public listing and search pages. There is no
  public read API: Google's own Chrome Web Store API only manages the
  caller's OWN published items (OAuth, developer-scoped) and cannot look up
  someone else's extension, so this pack reads the public pages the same way
  a browser would.

## Known limits

- **No public "list a developer's extensions" page exists.** `_by_publisher`
  runs the publisher name through the public search, then opens each
  candidate's own listing and keeps only the ones whose rendered `Developer`
  disclosure actually names that publisher. That is an approximation of
  "all" bounded by what Chrome Web Store's own search surfaces for that
  query — not a guaranteed-complete catalog of everything a publisher has
  shipped. It also makes one extra HTTP call per candidate checked
  (`max_checked`, default 10, max 25), so keep it modest.
- **Not-found is a parse condition, not an HTTP status.** An id with no live
  listing still answers HTTP 200 (Google redirects to a canonical
  `empty-title` slug with no matching data) — `chrome_web_store_extension`
  treats "no data item matches the requested id" as the not-found signal and
  returns `found: false`, never a silently-empty success.
- **The slug in a detail URL is cosmetic.** `/detail/<anything>/<id>`
  redirects to the real canonical slug server-side regardless of what
  precedes the id, so this pack never needs to know an extension's display
  slug — only its id.
- **Field extraction reads Google's embedded page data, not a documented
  API**, so a Chrome Web Store redesign could change the shape. The pack
  detects that defensively: it walks the page's embedded JSON for an array
  whose first element is a 32-character extension id (Chrome's own id
  alphabet, `a`-`p` only) rather than assuming a fixed block number, and it
  raises a loud `upstream_parse` error — naming the URL and body length —
  if a match is found but every field comes back empty, instead of
  returning an empty success.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "chrome-web-store": {
      "url": "https://gateway.pipeworx.io/chrome-web-store/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/chrome-web-store/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1863+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/chrome_web_store_extension \
  -H 'Content-Type: application/json' \
  -d '{"id":"kbfnbcaeplbcioakkpcpgfkobkghlhen"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/chrome_web_store_extension`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-chrome-web-store` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/chrome-web-store/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "chrome-web-store": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-chrome-web-store"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Chrome Web Store data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
