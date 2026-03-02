---
'@enbox/gitd': patch
---

Fix daemon lifecycle UX: bun spawn crash, auto-backgrounding, port conflicts

- **Fix bun spawn crash**: Replace `createWriteStream` with `openSync` fd in
  `spawnDaemon()`. Bun does not support `stream.Writable` as stdio — only raw
  file descriptors, `'pipe'`, `'ignore'`, and `'inherit'`.

- **Auto-background `gitd serve`**: Running `gitd serve` now forks a background
  daemon and exits immediately (Ollama pattern). Use `gitd serve --foreground`
  to block the terminal for debugging. Status is available via `gitd serve status`.

- **EADDRINUSE handling**: When the server port is already in use, show a clear
  error message with hints (`gitd serve status`, `gitd serve stop`, `--port`)
  instead of a raw stack trace.

- **Fast-fail on spawn errors**: `spawnDaemon` now detects child process errors
  (e.g. ENOENT when gitd binary is missing) immediately instead of polling for
  15 seconds before timing out.
