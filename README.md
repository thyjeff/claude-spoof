# Claude Spoof Proxy

A proxy server that makes non-Anthropic models appear as Anthropic models to **Claude Code** and **Claude Desktop** (Cowork 3P). Route Claude's requests to any OpenAI-compatible provider — OpenRouter, DeepSeek, Ollama, or your own gateway.

## How it works

```
Claude Code/Desktop  →  Spoof Proxy (localhost:8080)  →  Any OpenAI-compatible provider
                              │
                              └── Translates Anthropic Messages API ↔ OpenAI Chat Completions
                              └── Spoofs model name in responses (Claude thinks it's Anthropic)
```

## Quick Start

```bash
# 1. Clone & install
git clone https://github.com/yourname/claude-spoof-proxy
cd claude-spoof-proxy

# Run installer (installs deps, links globally, adds to PATH)
install.bat

# 2. Configure providers & models
copy config.example.json config.json
# Edit config.json — add your API keys and model mappings

# --- Open a NEW terminal ---

# 3. Start the proxy
csp start

# 4. Point Claude Code to it
set ANTHROPIC_BASE_URL=http://localhost:8080
set ANTHROPIC_API_KEY=anything
claude
```

For **Claude Desktop / Cowork 3P**:
- Open Developer → Configure Third-party Inference
- Gateway base URL: `http://localhost:8080`
- Gateway API key: (leave blank unless PROXY_AUTH_TOKEN is set)

## CLI Portal

```bash
csp start                   Start proxy as background daemon
csp stop                    Stop the proxy
csp restart                 Restart the proxy
csp status                  Show live stats (requests, errors, uptime, per-model)
csp models                  List all model mappings
csp providers               List configured providers
csp dashboard               Live-updating dashboard (Ctrl+C to exit)
csp config                  Show current configuration
csp logs                    Tail proxy logs
csp reload                  Hot-reload config.json without restart

csp add <name> <target>     Add model mapping (e.g. csp add claude-sonnet-4-20250514 openrouter:deepseek/deepseek-chat)
csp remove <name>           Remove a mapping
csp switch <name> <target>  Change a mapping target in real-time

csp provider-add <name> <url> <key>   Add a new provider
csp provider-remove <name>            Remove a provider
```

## Setup

```bash
# 1. Copy the example config and add your API keys
copy config.example.json config.json
# Edit config.json with your real providers and API keys

# 2. Install dependencies
npm install

# 3. Make `csp` available globally
npm link

# 4. Start the proxy
csp start
```

## Configuration

Edit `config.json` (copy from `config.example.json` first):

```json
{
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "sk-or-v1-..."
    },
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-..."
    },
    "ollama": {
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "your-key"
    }
  },
  "mappings": {
    "claude-sonnet-4-20250514":  "openrouter:deepseek/deepseek-chat",
    "claude-opus-4-20250514":    "openrouter:openai/gpt-4o",
    "claude-haiku-3-5-20241022": "deepseek:deepseek-chat"
  },
  "default": "openrouter:deepseek/deepseek-chat"
}
```

Each mapping is `providerName:actualModelName`. The proxy routes each request to the correct provider's base URL.

## Features

- **Multi-provider** — Route different Claude models to different upstream providers
- **Real-time switching** — Change models on the fly with `csp switch`, no restart needed
- **Full streaming** — SSE streaming with proper Anthropic event format
- **Tool use** — Function calling conversion between Anthropic and OpenAI formats
- **Image support** — Base64 image passthrough
- **Live dashboard** — Real-time stats with model-level breakdown
- **Spoofing** — All responses appear as a real Anthropic model to the client

## Requirements

- Node.js 18+
- An API key from your upstream provider (OpenRouter, DeepSeek, etc.)

## License

MIT
