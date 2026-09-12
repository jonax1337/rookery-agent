#!/usr/bin/env bash
# Exercise installer control flow without downloading, installing, or starting anything.
set -euo pipefail
if [[ $EUID == 0 ]]; then echo 'Run installer smoke checks as a non-root user.'; exit 1; fi
installer=$(cd "$(dirname "$0")" && pwd)/install.sh
test_root=$(mktemp -d)
trap 'rm -rf -- "$test_root"' EXIT
export test_root
uname() { echo Linux; }
node() { return 0; }
codex() { return 0; }
curl() { touch "${@: -1}"; }
tar() { return 0; }
systemctl() { [[ $test_manager == yes ]]; }
npm() {
  printf '%s\n' "$*" >>"$test_root/commands"
  if [[ $* == 'run package' ]]; then mkdir -p dist; touch dist/rookery-agent-0.1.0.tgz; fi
  if [[ $1 == install ]]; then
    mkdir -p "$HOME/.local/bin"
    cat >"$HOME/.local/bin/rookery" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$test_root/launcher"
EOF
    chmod +x "$HOME/.local/bin/rookery"
  fi
}
export -f uname node codex curl tar systemctl npm
for test_manager in yes no; do
  export test_manager
  export HOME="$test_root/home-$test_manager"
  mkdir -p "$HOME"
  : >"$test_root/launcher"
  bash "$installer" >/dev/null
  if [[ $test_manager == yes ]]; then expected=setup; else expected='setup --no-autostart'; fi
  [[ $(cat "$test_root/launcher") == "$expected" ]]
done
grep -q '^ci --ignore-scripts$' "$test_root/commands"
grep -q '^install --global --prefix .* --ignore-scripts dist/rookery-agent-0.1.0.tgz$' "$test_root/commands"
echo 'PASS: Linux installer uses per-user installation and selects setup with/without systemd.'
