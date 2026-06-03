# MyLLM Image MCP Server

An [MCP](https://modelcontextprotocol.io) server that lets MCP clients
(Claude Code, etc.) generate images through a MyLLM deployment's
`/v1/images/generations` endpoint.

## Tool

### `generate_image`

| Param | Type | Notes |
|---|---|---|
| `prompt` | string (required) | Description of the image. |
| `model` | string (optional) | Specific image model id. Omit → MyLLM auto-routes. |
| `size` | string (optional) | e.g. `1024x1024`. Default `1024x1024`. |
| `n` | number (optional) | 1–4 images. Default 1. |
| `save_dir` | string (optional) | Output directory. Default cwd / `MYLLM_IMAGE_DIR`. |

Returns the image(s) inline (so the client can display them) and writes a
PNG file per image, reporting the saved path(s).

## Build

```bash
cd mcp
npm install
npm run build
```

## Configuration

Set via the MCP client's server env — never hard-coded:

| Env | Required | Meaning |
|---|---|---|
| `MYLLM_API_URL` | yes | Base URL, e.g. `https://myapi.example.com` |
| `MYLLM_API_KEY` | yes | Unified Bearer key (from the MyLLM dashboard) |
| `MYLLM_IMAGE_DIR` | no | Default save directory |

## Register with Claude Code

```bash
claude mcp add myllm-image \
  --env MYLLM_API_URL=https://myapi.example.com \
  --env MYLLM_API_KEY=<your-unified-key> \
  -- node /absolute/path/to/myllm/mcp/dist/index.js
```

Or add to `.mcp.json` / Claude Code settings:

```json
{
  "mcpServers": {
    "myllm-image": {
      "command": "node",
      "args": ["C:/Users/seyh/Desktop/projeler/myllm/mcp/dist/index.js"],
      "env": {
        "MYLLM_API_URL": "https://myapi.example.com",
        "MYLLM_API_KEY": "<your-unified-key>"
      }
    }
  }
}
```

Then in Claude Code: ask it to generate an image and it will call the tool.

## Local test

```bash
MYLLM_API_URL=... MYLLM_API_KEY=... node test-client.mjs "a prompt here"
```

Runs the handshake, lists tools, and (with a prompt arg) calls
`generate_image` once.
