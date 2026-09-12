#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -s) != Linux ]]; then
  echo 'This installer supports Linux. Use install.ps1 on Windows.' >&2
  exit 1
fi
if [[ $EUID == 0 ]]; then
  echo 'Run this installer as your normal user, without sudo, to reuse your provider login.' >&2
  exit 1
fi
for command in node npm curl tar; do
  command -v "$command" >/dev/null || { echo "Install $command first (Node.js 22.5 or newer is required)." >&2; exit 1; }
done
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' || {
  echo 'Update Node.js to 22.5 or newer, then run this installer again.' >&2
  exit 1
}

install_temp=$(mktemp -d)
trap 'rm -rf -- "$install_temp"' EXIT
curl --fail --silent --show-error --location https://github.com/jonax1337/rookery-agent/archive/refs/heads/main.tar.gz -o "$install_temp/source.tar.gz"
mkdir "$install_temp/source"
tar -xzf "$install_temp/source.tar.gz" --strip-components=1 -C "$install_temp/source"
cd "$install_temp/source"
npm ci --ignore-scripts
npm run package
packages=(dist/*.tgz)
[[ ${#packages[@]} == 1 && -f ${packages[0]} ]] || { echo 'Expected one release package.' >&2; exit 1; }
# Per-user installation avoids sudo and leaves the system Node installation alone.
prefix="$HOME/.local"
npm install --global --prefix "$prefix" --ignore-scripts "${packages[0]}"
export PATH="$prefix/bin:$PATH"

if ! command -v codex >/dev/null && ! command -v claude >/dev/null; then
  choice=3
  if [[ -r /dev/tty && -w /dev/tty ]]; then
    printf 'Install a provider: [1] Codex, [2] Claude Code, [3] Later (default: 1): ' >/dev/tty
    read -r choice </dev/tty || choice=3
    choice=${choice:-1}
  fi
  case "$choice" in
    1|2)
      if [[ $choice == 2 ]]; then provider=claude; package=@anthropic-ai/claude-code
      else provider=codex; package=@openai/codex; fi
      npm install --global --prefix "$prefix" --ignore-scripts "$package"
      if [[ $provider == claude ]]; then "$prefix/bin/claude" auth login </dev/tty || echo 'Finish Claude login before chatting.'
      else "$prefix/bin/codex" login </dev/tty || echo 'Finish Codex login before chatting.'; fi
      if [[ ! -f ${ROOKERY_HOME:-$HOME/.rookery}/config.json ]]; then
        "$prefix/bin/rookery" config set defaultProvider "$provider"
      fi
      ;;
    *) echo 'Install and sign in to a provider CLI before chatting.' ;;
  esac
fi

if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  "$prefix/bin/rookery" setup
else
  echo 'No systemd user session: installing without autostart.'
  "$prefix/bin/rookery" setup --no-autostart
fi
printf '\nInstalled in %s. If rookery is not found in a new shell, add %s/bin to PATH.\n' "$prefix" "$prefix"
