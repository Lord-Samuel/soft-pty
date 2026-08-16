# soft-pty

node-pty's API, no native addon. Just `child_process.spawn()` under the hood, dressed up enough to be useful for the boring 90% case (shells, REPLs, CLIs).

Not a real pty. If you need vim/htop/curses stuff to actually render, or real SIGWINCH, go use node-pty — it's a native binding to an actual pty and doesn't have the gaps below. This is for when you can't ship a native addon (weird CI images, Electron rebuild hell, some sandbox that won't let you compile) and don't need full terminal fidelity.

## install

```bash
npm install soft-pty
```

## usage

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

Same shape as node-pty so it's a drop-in for simple call sites — `spawn`, `.pid`, `.process`, `onData`, `onExit`, `write`, `resize`, `kill` all match.

## what it actually does

- spawns with `child_process.spawn`, stdio all piped
- sets `TERM` / `FORCE_COLOR` / `CLICOLOR_FORCE` so chalk and friends don't strip colors just because stdout isn't a real tty
- merges stdout + stderr into one `data` stream, in arrival order
- `opts.echo` for local echo of writes, since there's no kernel echo without a real tty

## options

| option | default | notes |
|---|---|---|
| `name` | `'xterm-256color'` | sets `TERM` |
| `cols`, `rows` | `80`, `24` | sets `COLUMNS`/`LINES` env, see resize note below |
| `cwd` | `process.cwd()` | |
| `env` | `process.env` | |
| `echo` | `false` | locally echo bytes passed to `write()` |
| `encoding` | `'utf8'` | pass `null` to get raw `Buffer`s back instead of strings — binary safe |
| `handleFlowControl` | `false` | intercept flow-control bytes in `write()` instead of forwarding them to the child (see below) |
| `flowControlPause` | `'\x13'` (DC3/XOFF) | byte that triggers `pause()` when `handleFlowControl` is on |
| `flowControlResume` | `'\x11'` (DC1/XON) | byte that triggers `resume()` when `handleFlowControl` is on |
| `uid`, `gid`, `argv0` | — | passed straight through to `child_process.spawn` |

## other node-pty methods this has

- `pause()` / `resume()` — actually pauses/resumes the output streams, not cosmetic. Tested it: froze a counter mid-stream, confirmed it stopped incrementing, called resume, confirmed it picked back up.
- flow control — if you pass `handleFlowControl: true`, writing the XOFF byte (`\x13`) calls `pause()` instead of forwarding it to the child's stdin, and XON (`\x11`) calls `resume()`. Same behavior node-pty documents (xterm.js uses this for backpressure).
- `clear()` exists but does nothing. Real node-pty clears the terminal's actual scrollback buffer — there isn't one here, this thing just relays process output. Kept it as a no-op so code written against the real IPty interface doesn't throw calling it.
- `term.on('data', cb)` / `term.on('exit', cb)` also work directly, not just `onData`/`onExit` — this extends EventEmitter and emits those events, so both styles are fine.


## bugs I found while testing this (fixed, but writing them down)

Fixed all of these:

1. **emoji/multi-byte UTF-8 gets corrupted.** Doing `buf.toString('utf8')` on each raw chunk is wrong if a multi-byte char lands on a chunk boundary — you get stray `\uFFFD` chars. Switched to `StringDecoder` per stream, which correctly holds back partial bytes until the next chunk finishes them off.

2. **`exit` fires before output is fully drained.** This one's in the node docs if you read closely enough but it's easy to miss — `'exit'` can fire before all the buffered stdout `data` events made it to you. Only showed up for me under load (25+ processes spawned at once, occasionally one would report `exitCode: 0` with completely empty captured output). Switched to listening on `'close'` instead, which node actually guarantees fires after all the stdio data is done.

3. **spawn failure + `onExit`-only listener = hang forever.** If spawn fails (bad binary path, ENOENT, whatever) node only emits `'error'`, never `'exit'`. But most people using this thing are gonna wire up `onData`/`onExit` like node-pty's docs tell you to, and never touch `'error'` — so they'd just hang forever waiting for an exit that's never coming.

4. **spawn failure + no `'error'` listener = crashes your whole app.** Related to #3 but worse. `EventEmitter` throws an *uncaught exception* if you emit `'error'` and nobody's listening. So if you only wired `onExit` (again, the normal thing to do), a bad path wouldn't just hang — it'd take down your entire process. Fixed by only emitting `'error'` if someone's actually listening, and always synthesizing an `exit` either way so `onExit`-only consumers still get resolved.

5. **EPIPE crash writing to a fast-exiting process.** Hammered writes against 300 `bash -c "exit 0"` processes in a tight loop to see what'd happen when stdin closes out from under you. Got a pile of uncaught EPIPE crashes. `write()` was only checking `this._exited`, but there's a real gap between the process closing stdin and our `close` handler noticing. Now swallows stdin write errors instead of letting them take the process down.

Also threw in SIGTERM→SIGKILL escalation on `kill()` — if a process traps/ignores the signal you send it, it gets force-killed after a grace period (3000ms default, `kill(signal, { graceMs })` to change it, `{ escalate: false }` to turn it off).

## what this can't do YET

- **no curses / full-screen programs.** vim, htop, `less -F`, top, whatever — they check `isatty()` and either bail or render garbage. Not fixable without a real pty.
- **resize doesn't actually resize anything.** `term.resize()` just updates some internal state and env vars. There's no `SIGWINCH` without a real pty, so any program that already started won't notice.
- **stdout/stderr order is best-effort.** Real terminal = one fd = guaranteed byte-level interleaving. Here it's two pipes getting merged as their events happen to arrive. Close enough most of the time, not a guarantee.
- **colors are coaxed, not forced.** Some tools check for a real tty through means other than env vars and turn color off anyway no matter what I do.
- **no job control signals.** Ctrl+C from a real terminal generates SIGINT via the tty driver automatically. Here you gotta call `term.kill('SIGINT')` yourself.

Basically: don't use this if you need real terminal behavior. Use it if you need something node-pty-shaped and can't deal with the native addon.
