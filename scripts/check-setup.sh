#!/usr/bin/env bash
# Checks the dev environment: Nix shell, toolchain, env vars, Cloudflare token.
set -uo pipefail
cd "$(dirname "$0")/.."

failures=0
ok() { printf '  \e[32m✓\e[0m %s\n' "$1"; }
warn() { printf '  \e[33m!\e[0m %s\n' "$1"; }
fail() { printf '  \e[31m✗\e[0m %s\n' "$1"; failures=$((failures + 1)); }
section() { printf '\n\e[1m%s\e[0m\n' "$1"; }

section "Nix shell"
if [[ -n "${IN_NIX_SHELL:-}" ]]; then ok "inside nix develop ($IN_NIX_SHELL)"; else fail "not in the Nix shell: run nix develop or direnv allow"; fi
for tool in cargo rustc node pnpm just jq resvg magick; do
  if path=$(command -v "$tool"); then
    [[ "$path" == /nix/store/* ]] && ok "$tool" || warn "$tool comes from $path, not Nix"
  else
    fail "$tool missing"
  fi
done
if command -v rustc >/dev/null; then
  [[ -d "$(rustc --print sysroot)/lib/rustlib/aarch64-unknown-linux-gnu" ]] \
    && ok "target aarch64-unknown-linux-gnu" || fail "target aarch64-unknown-linux-gnu not installed"
fi

section "Environment"
[[ -n "${CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER:-}" ]] && ok "aarch64 linker" || fail "aarch64 linker unset"
[[ -d node_modules && -d api/node_modules && -d app/node_modules && -d website/node_modules ]] && ok "JS dependencies installed" \
  || warn "JS dependencies missing: just deps"
if [[ -f .env ]]; then ok ".env present"; else warn ".env missing: cp .env.example .env"; fi
[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] && ok "CLOUDFLARE_API_TOKEN set" || warn "CLOUDFLARE_API_TOKEN unset (needed to deploy)"
[[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] && ok "CLOUDFLARE_ACCOUNT_ID set" || warn "CLOUDFLARE_ACCOUNT_ID unset"
[[ -n "${SECRETS_KEY:-}" ]] && ok "SECRETS_KEY set" || warn "SECRETS_KEY unset: just secrets-key"
[[ -n "${E2E_ADMIN_PASSWORD:-}" && -n "${E2E_USER_PASSWORD:-}" ]] && ok "e2e test accounts configured" \
  || warn "E2E_ADMIN_PASSWORD / E2E_USER_PASSWORD unset (just e2e needs them)"
[[ -d "${PLAYWRIGHT_BROWSERS_PATH:-}" ]] && ok "Playwright browsers from Nix" || fail "PLAYWRIGHT_BROWSERS_PATH missing"
grep -q '"database_id": "00000000-0000-0000-0000-000000000000"' api/wrangler.jsonc \
  && warn "api/wrangler.jsonc has the placeholder D1 id: just create-db" || ok "D1 database id configured"

section "Cloudflare"
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" && -d api/node_modules ]]; then
  if (cd api && timeout 30 pnpm exec wrangler whoami >/dev/null 2>&1); then
    ok "token valid"
  else
    fail "wrangler whoami failed: check the token"
  fi
else
  warn "skipped (no token)"
fi

echo
if ((failures)); then printf '\e[31m%d problem(s)\e[0m\n' "$failures"; exit 1; fi
printf '\e[32mSetup OK\e[0m\n'
