# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Report privately via GitHub's [security advisory](https://github.com/JescaLyn/openrouter-mcp/security/advisories/new) feature, or email the maintainer directly (see the commit log for contact info).

Include: a description of the issue, steps to reproduce, and the potential impact.

## Credential handling

This server handles an OpenRouter API key. The recommended setup (Keychain on macOS, environment variable on Linux/Windows) keeps the key out of `~/.claude.json` and out of Claude's context. See [README.md § Install](README.md#2-install) for details.

The project's `.claude/settings.local.json` denies `Bash(security *)`, `Read(.env)`, `Read(.env.*)`, `Read(.envrc)`, and `Bash(printenv OPENROUTER*)` to prevent accidental exfiltration via tool calls.

## Scope

This server makes outbound HTTPS requests to `https://openrouter.ai` only. It does not bind to any port or accept inbound connections.
