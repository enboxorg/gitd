#!/usr/bin/env bash

set -euo pipefail

PACKAGE='@enbox/dwn-git'

log() {
  printf '==> %s\n' "$*"
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

is_windows() {
  case "$(uname -s)" in
    CYGWIN*|MINGW*|MSYS*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

install_bun() {
  if is_windows; then
    if ! has_command powershell.exe; then
      fail 'Bun is required and powershell.exe was not found to install it.'
    fi

    log 'Installing Bun via PowerShell'
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& { irm https://bun.sh/install.ps1 | iex }"
    return
  fi

  if has_command curl; then
    log 'Installing Bun via curl'
    curl -fsSL https://bun.sh/install | bash
    return
  fi

  if has_command wget; then
    log 'Installing Bun via wget'
    wget -qO- https://bun.sh/install | bash
    return
  fi

  fail 'Bun is required and neither curl nor wget is available to install it.'
}

resolve_bun() {
  if has_command bun; then
    printf '%s\n' "$(command -v bun)"
    return
  fi

  local bun_install_dir
  bun_install_dir="${BUN_INSTALL:-$HOME/.bun}"

  if [ -x "$bun_install_dir/bin/bun" ]; then
    PATH="$bun_install_dir/bin:$PATH"
    printf '%s\n' "$bun_install_dir/bin/bun"
    return
  fi

  if [ -x "$bun_install_dir/bin/bun.exe" ]; then
    PATH="$bun_install_dir/bin:$PATH"
    printf '%s\n' "$bun_install_dir/bin/bun.exe"
    return
  fi

  fail 'Unable to locate Bun after installation.'
}

main() {
  log 'Installing dwn-git CLI'

  if ! has_command bun; then
    install_bun
  fi

  local bun_cmd
  bun_cmd="$(resolve_bun)"

  "$bun_cmd" add -g "$PACKAGE"

  local bun_install_dir
  bun_install_dir="${BUN_INSTALL:-$HOME/.bun}"
  PATH="$bun_install_dir/bin:$PATH"

  if ! has_command dwn-git; then
    fail 'Installation completed, but dwn-git is not on PATH.'
  fi

  log 'Installed successfully'
  dwn-git --version

  printf 'If this is your first Bun install, add this to your shell profile:\n'
  printf '  export BUN_INSTALL="%s"\n' "$bun_install_dir"
  printf '  export PATH="$BUN_INSTALL/bin:$PATH"\n'
}

main "$@"
