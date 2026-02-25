#!/usr/bin/env bash

set -euo pipefail

APP='dwn-git'
REPO='enboxorg/dwn-git'
INSTALL_DIR="${HOME}/.${APP}/bin"
REQUESTED_VERSION="${VERSION:-}"
NO_MODIFY_PATH=false
TMP_DIR=''

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

usage() {
  cat <<'EOF'
dwn-git installer

Usage: install.sh [options]

Options:
  -h, --help              Show this help message
  -v, --version <version> Install a specific version (example: 0.0.1)
      --no-modify-path    Do not modify shell profile files

Examples:
  curl -fsSL https://gitd.sh/install | bash
  curl -fsSL https://gitd.sh/install | bash -s -- --version 0.0.1
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

download_file() {
  local url="$1"
  local out="$2"

  if has_command curl; then
    curl -fsSL "$url" -o "$out"
    return
  fi

  if has_command wget; then
    wget -q "$url" -O "$out"
    return
  fi

  fail 'curl or wget is required'
}

detect_os() {
  case "$(uname -s)" in
    Linux) printf 'linux' ;;
    Darwin) printf 'darwin' ;;
    CYGWIN*|MINGW*|MSYS*) printf 'windows' ;;
    *) fail 'unsupported operating system' ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    aarch64|arm64) printf 'arm64' ;;
    *) fail 'unsupported CPU architecture' ;;
  esac
}

latest_tag() {
  http_get "https://api.github.com/repos/${REPO}/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

resolve_tag() {
  if [ -z "$REQUESTED_VERSION" ]; then
    latest_tag
    return
  fi

  case "$REQUESTED_VERSION" in
    v*) printf '%s' "$REQUESTED_VERSION" ;;
    *) printf 'v%s' "$REQUESTED_VERSION" ;;
  esac
}

extract_archive() {
  local archive="$1"
  local out_dir="$2"
  local os="$3"

  if [ "$os" = 'windows' ]; then
    if ! has_command unzip; then
      fail 'unzip is required for Windows artifacts'
    fi
    unzip -q "$archive" -d "$out_dir"
    return
  fi

  if ! has_command tar; then
    fail 'tar is required'
  fi
  tar -xzf "$archive" -C "$out_dir"
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
    printf '\n# dwn-git\n%s\n' "$line" >> "$config"
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

  local os
  os="$(detect_os)"
  local arch
  arch="$(detect_arch)"
  local tag
  tag="$(resolve_tag)"
  [ -n "$tag" ] || fail 'unable to determine release tag'

  local archive=''
  if [ "$os" = 'windows' ]; then
    archive="dwn-git-${os}-${arch}.zip"
  else
    archive="dwn-git-${os}-${arch}.tar.gz"
  fi

  local url
  url="https://github.com/${REPO}/releases/download/${tag}/${archive}"

  TMP_DIR="$(mktemp -d)"

  printf '==> Installing dwn-git %s\n' "$tag"
  download_file "$url" "${TMP_DIR}/${archive}"
  extract_archive "${TMP_DIR}/${archive}" "$TMP_DIR" "$os"

  mkdir -p "$INSTALL_DIR"

  local suffix=''
  if [ "$os" = 'windows' ]; then
    suffix='.exe'
  fi

  cp "${TMP_DIR}/dwn-git${suffix}" "${INSTALL_DIR}/dwn-git${suffix}"
  cp "${TMP_DIR}/git-remote-did${suffix}" "${INSTALL_DIR}/git-remote-did${suffix}"
  cp "${TMP_DIR}/git-remote-did-credential${suffix}" "${INSTALL_DIR}/git-remote-did-credential${suffix}"

  chmod +x "${INSTALL_DIR}/dwn-git${suffix}"
  chmod +x "${INSTALL_DIR}/git-remote-did${suffix}"
  chmod +x "${INSTALL_DIR}/git-remote-did-credential${suffix}"

  if [ "$NO_MODIFY_PATH" = false ] && [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
    add_to_path
  fi

  printf '==> Installed to %s\n' "$INSTALL_DIR"
  "${INSTALL_DIR}/dwn-git${suffix}" --version || true
  printf 'Run: dwn-git setup\n'
}

main "$@"
