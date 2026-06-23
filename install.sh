#!/usr/bin/env bash

set -euo pipefail

APP='gitd'
PACKAGE='@enbox/gitd'
INSTALL_DIR="${HOME}/.${APP}/bin"
REQUESTED_VERSION="${VERSION:-}"
NO_MODIFY_PATH=false

usage() {
  cat <<'EOF'
gitd installer

Usage: install.sh [options]

Options:
  -h, --help              Show this help message
  -v, --version <version> Install a specific version (example: 0.9.6)
      --no-modify-path    Do not modify shell profile files

Examples:
  curl -fsSL https://gitd.sh/install | bash
  curl -fsSL https://gitd.sh/install | bash -s -- --version 0.9.6
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

has_command() {
  command -v "$1" >/dev/null 2>&1
}

http_get() {
  if has_command curl; then
    curl -fsSL "$1"
    return
  fi

  if has_command wget; then
    wget -qO- "$1"
    return
  fi

  fail 'curl or wget is required'
}

detect_os() {
  case "$(uname -s)" in
    Linux) printf 'linux' ;;
    Darwin) printf 'darwin' ;;
    *) fail 'unsupported operating system' ;;
  esac
}

resolve_package_version() {
  if [ -z "$REQUESTED_VERSION" ]; then
    printf 'latest'
    return
  fi

  case "$REQUESTED_VERSION" in
    v*) printf '%s' "${REQUESTED_VERSION#v}" ;;
    *) printf '%s' "$REQUESTED_VERSION" ;;
  esac
}

ensure_bun() {
  if has_command bun; then
    return
  fi

  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  printf '==> Bun is required; installing Bun to %s\n' "$BUN_INSTALL"
  http_get 'https://bun.sh/install' | bash

  export PATH="${BUN_INSTALL}/bin:$PATH"
  if ! has_command bun; then
    fail "Bun installed, but ${BUN_INSTALL}/bin/bun is not available"
  fi
}

shell_quote() {
  printf '%q' "$1"
}

write_wrapper() {
  local name="$1"
  local source="$2"
  local bun_path="$3"
  local out="${INSTALL_DIR}/${name}"

  if [ ! -e "$source" ]; then
    fail "bun did not install ${name}"
  fi

  local quoted_bun
  quoted_bun="$(shell_quote "$bun_path")"
  local quoted_source
  quoted_source="$(shell_quote "$source")"

  if [ -e "$out" ] || [ -L "$out" ]; then
    rm -f "$out"
  fi

  {
    printf '#!/usr/bin/env bash\n'
    printf 'exec %s %s "$@"\n' "$quoted_bun" "$quoted_source"
  } > "$out"
  chmod +x "$out"
}

add_to_path() {
  local shell_name
  shell_name="$(basename "${SHELL:-bash}")"

  local line
  line="export PATH=${INSTALL_DIR}:\$PATH"

  local files=''
  case "$shell_name" in
    zsh) files="${ZDOTDIR:-$HOME}/.zshrc ${ZDOTDIR:-$HOME}/.zshenv" ;;
    bash) files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile" ;;
    *) files="$HOME/.profile" ;;
  esac

  local config=''
  for file in $files; do
    if [ -f "$file" ]; then
      config="$file"
      break
    fi
  done

  if [ -z "$config" ]; then
    printf 'Add this to your shell profile:\n'
    printf '  %s\n' "$line"
    return
  fi

  if grep -Fxq "$line" "$config"; then
    return
  fi

  if [ -w "$config" ]; then
    printf '\n# gitd\n%s\n' "$line" >> "$config"
    printf 'Updated PATH in %s\n' "$config"
    return
  fi

  printf 'Add this to your shell profile:\n'
  printf '  %s\n' "$line"
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        usage
        exit 0
        ;;
      -v|--version)
        if [[ -z "${2:-}" ]]; then
          fail '--version requires an argument'
        fi
        REQUESTED_VERSION="$2"
        shift 2
        ;;
      --no-modify-path)
        NO_MODIFY_PATH=true
        shift
        ;;
      *)
        fail "unknown option: $1"
        ;;
    esac
  done

  detect_os >/dev/null
  ensure_bun

  local package_version
  package_version="$(resolve_package_version)"
  [ -n "$package_version" ] || fail 'unable to determine package version'

  local package_spec="${PACKAGE}@${package_version}"
  printf '==> Installing %s\n' "$package_spec"
  bun add -g "$package_spec"

  mkdir -p "$INSTALL_DIR"

  local bun_path
  bun_path="$(command -v bun)"
  local bun_global_bin
  bun_global_bin="$(bun pm bin -g)"

  write_wrapper 'gitd' "${bun_global_bin}/gitd" "$bun_path"
  write_wrapper 'git-remote-did' "${bun_global_bin}/git-remote-did" "$bun_path"
  write_wrapper 'git-remote-did-credential' "${bun_global_bin}/git-remote-did-credential" "$bun_path"

  if [ "$NO_MODIFY_PATH" = false ] && [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
    add_to_path
  fi

  printf '==> Installed to %s\n' "$INSTALL_DIR"
  "${INSTALL_DIR}/gitd" --version
  printf 'Run: gitd setup\n'
}

main "$@"
