# soft-pty

A pure-JS, zero-native-dependency approximation of [`node-pty`](https://github.com/microsoft/node-pty)'s API, built entirely on `child_process.spawn()`.

There is no real pseudo-terminal underneath. This package exists for cases where you want `node-pty`'s ergonomics (spawn a shell, get a data stream, write input, resize, kill) but can't or don't want to deal with `node-pty`'s native addon (platform prebuilds, `node-gyp`, Electron rebuild pain, etc.), and your use case doesn't require full terminal fidelity.

## Install

```bash
npm install soft-pty
```

## Usage

```js
const pty = require('soft-pty');

const term = pty.spawn('bash', [], {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.env.HOME,
  env: process.env,
});

term.onData((data) => process.stdout.write(data));
term.onExit(({ exitCode, signal }) => {
  console.log(`process exited: code=${exitCode} signal=${signal}`);
});

term.write('ls -la\r');
term.resize(100, 40);

// later
term.kill();
```

This mirrors `node-pty`'s surface closely enough to be a drop-in for simple call sites:

| node-pty            | soft-pty            |
|----------------------|----------------------|
| `pty.spawn(...)`     | `pty.spawn(...)`     |
| `term.pid`           | `term.pid`           |
| `term.process`       | `term.process`       |
| `term.onData(cb)`    | `term.onData(cb)`    |
| `term.onExit(cb)`    | `term.onExit(cb)`    |
| `term.write(data)`   | `term.write(data)`   |
| `term.resize(c, r)`  | `term.resize(c, r)`  |
| `term.kill(signal)`  | `term.kill(signal)`  |

## What it does under the hood

- Spawns via `child_process.spawn` with piped stdio (`['pipe','pipe','pipe']`).
- Sets `TERM`, `FORCE_COLOR`, and `CLICOLOR_FORCE` env vars so libraries like chalk/supports-color still emit ANSI codes despite stdout being a pipe rather than a real tty.
- Merges `stdout` and `stderr` chunks into a single `data` event in arrival order.
- Optional local echo of writes via `opts.echo`, since there's no kernel-level echo without a real tty.

## Honest limitations (read before you rely on this)

This is **not** a pty. Be deliberate about where you use it:

- **No full-screen / curses programs.** `vim`, `htop`, `less -F`, `top`, etc. probe `isatty()` and either refuse to run correctly or fall back to degraded output. If you need these to work, use `node-pty`.
- **Resize is cosmetic.** `term.resize()` updates internal state only. There is no real `SIGWINCH` delivery path without a controlling tty, so most running programs will never see the new size. `COLUMNS`/`LINES` env vars are only read by programs that check them, and only at the point they check.
- **stdout/stderr interleaving is best-effort, not exact.** A real terminal has one fd, so writes to "stdout" and "stderr" are byte-interleaved in true wall-clock order. Here they're two separate pipes merged as their `data` events arrive — ordering is close in practice for line-buffered output but not guaranteed at the byte level.
- **Color support is coaxed, not guaranteed.** Some tools still detect the absence of a real tty through means other than env vars and will disable color anyway.
- **No job-control signals** like a real pty would deliver (e.g. `Ctrl+C` from a physical terminal generates `SIGINT` via the tty driver; here you'd need to call `term.kill('SIGINT')` yourself).

If any of these matter for your use case, use `node-pty` instead — it wraps a real pty via native bindings and doesn't have these gaps.

## When this package is a reasonable choice

- Running short, non-interactive, or line-oriented commands and capturing their output.
- Simple REPLs where you write a line, read a line back.
- Environments where you can't ship a native addon (odd CI images, certain sandboxes) but still want colorized output and a `node-pty`-shaped API.

## License

MIT
