'use strict';

const { spawn: cpSpawn } = require('child_process');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');

/**
 * SoftPty
 *
 * A drop-in-ish replacement for node-pty's IPty, built entirely on
 * child_process.spawn(). There is no real pseudo-terminal underneath,
 * which means:
 *
 *   - Full-screen / curses programs (vim, htop, less -F, etc.) will NOT
 *     render correctly. They probe for a real tty (isatty(fd)) and will
 *     usually fall back to dumb/line-buffered output, or refuse to run.
 *   - Resize is cosmetic. We update COLUMNS/LINES-style state and, where
 *     possible, environment variables for the *next* invocation, but we
 *     cannot deliver a real SIGWINCH the way a kernel pty does. Programs
 *     that only read the tty size once at startup will never see resizes.
 *   - stdout and stderr are two separate pipes under the hood. We merge
 *     their chunks into a single 'data' stream in delivery order as they
 *     arrive, but true byte-level interleaving (as a real terminal would
 *     produce, since both fds share one device) is not reproducible from
 *     two independent pipes. Ordering between the two streams is best
 *     effort, not guaranteed.
 *   - Color output is coaxed via TERM / FORCE_COLOR / CLICOLOR_FORCE env
 *     vars, since libraries like chalk/supports-color gate on isTTY and
 *     will otherwise strip ANSI codes when stdout is a pipe.
 *
 * Use this when you need a lightweight, dependency-free stand-in for
 * simple interactive processes (shells running short commands, REPLs,
 * line-oriented CLIs) and can't or don't want to build node-pty's native
 * addon. If you need real terminal fidelity, use node-pty.
 */

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

class SoftPty extends EventEmitter {
  /**
   * @param {string} file - executable to run (e.g. 'bash', 'zsh', 'node')
   * @param {string[]} args
   * @param {object} opts
   * @param {string} [opts.name='xterm-256color'] - TERM value to advertise
   * @param {number} [opts.cols=80]
   * @param {number} [opts.rows=24]
   * @param {string} [opts.cwd]
   * @param {object} [opts.env]
   * @param {boolean} [opts.echo=false] - locally echo bytes written via .write()
   * @param {string|null} [opts.encoding='utf8'] - node-pty compat: pass
   *   null to receive raw Buffer chunks via 'data' instead of decoded
   *   strings (binary-safe; skips StringDecoder entirely). Any other
   *   value is passed straight through to StringDecoder.
   */
  constructor(file, args = [], opts = {}) {
    super();

    this.file = file;
    this.args = args;
    this.cols = opts.cols || DEFAULT_COLS;
    this.rows = opts.rows || DEFAULT_ROWS;
    this._echo = !!opts.echo;
    this._exited = false;
    this._encoding = opts.encoding === undefined ? 'utf8' : opts.encoding;

    const env = Object.assign({}, opts.env || process.env, {
      TERM: opts.name || 'xterm-256color',
      FORCE_COLOR: '1',
      CLICOLOR_FORCE: '1',
      COLUMNS: String(this.cols),
      LINES: String(this.rows),
    });

    this._child = cpSpawn(file, args, {
      cwd: opts.cwd || process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // A child can close its stdin (naturally, by exiting) at any point,
    // including in the gap between that happening and our own 'close'
    // handler marking us _exited — write() is only guarded by _exited,
    // so a write can race into a stdin whose write end is already gone.
    // That fires 'error' (EPIPE/ENOENT/etc.) on the stdin stream itself,
    // which — like any EventEmitter 'error' with no listener — throws
    // and kills the whole process. Confirmed reproducible: hammering
    // writes at 300 fast-exiting ('exit 0') children reliably produced
    // dozens of uncaught EPIPE crashes. Swallow it here instead; the
    // child's own 'close'/'exit' path is the source of truth for
    // lifecycle, this is purely about not letting a lost write crash
    // the host process.
    this._child.stdin.on('error', () => {});

    this.pid = this._child.pid;
    this.process = file;
    /** Set if the underlying spawn failed (e.g. ENOENT). null otherwise. */
    this.spawnError = null;

    this._wireStreams();
    this._wireLifecycle();
  }

  _wireStreams() {
    // Each stream gets its own StringDecoder instance. A naive
    // buf.toString('utf8') per chunk corrupts multi-byte characters
    // (e.g. emoji) whenever the OS pipe splits them across two reads —
    // StringDecoder holds back incomplete trailing bytes until the next
    // chunk completes the sequence.
    // encoding: null (node-pty compat) skips decoding entirely and
    // hands back raw Buffer chunks for binary-safe consumers.
    const rawMode = this._encoding === null;
    const stdoutDecoder = rawMode ? null : new StringDecoder(this._encoding);
    const stderrDecoder = rawMode ? null : new StringDecoder(this._encoding);

    const onChunk = (decoder) => (buf) => {
      if (this._exited) return;
      if (rawMode) {
        this.emit('data', buf);
        return;
      }
      const str = decoder.write(buf);
      if (str) this.emit('data', str);
    };
    this._child.stdout.on('data', onChunk(stdoutDecoder));
    // Merged into the same 'data' event, in arrival order. See class
    // docstring: this is a best-effort merge, not true tty interleaving.
    this._child.stderr.on('data', onChunk(stderrDecoder));

    this._flushDecoders = () => {
      if (rawMode) return;
      const rest = stdoutDecoder.end() + stderrDecoder.end();
      if (rest) this.emit('data', rest);
    };

    this._child.on('error', (err) => {
      // IMPORTANT: EventEmitter treats 'error' specially — emitting it with
      // zero listeners throws an uncaught exception that kills the whole
      // process. node-pty consumers very commonly wire up only onData()/
      // onExit() (that's the documented pattern) and never touch 'error'
      // at all, so naively forwarding err via this.emit('error', err)
      // turns a spawn failure into a process crash for anyone following
      // that pattern. Only emit 'error' if someone is actually listening.
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
      // child_process also never emits 'exit' after a spawn-failure
      // 'error' — it just stops. Since onExit is the primary lifecycle
      // hook here, synthesize a terminal 'exit' so callers relying on it
      // don't hang forever waiting for a process that never started.
      // Guarded so we never double-emit if a real 'exit' also fires.
      if (!this._exited) {
        this._exited = true;
        if (this._flushDecoders) this._flushDecoders();
        this.spawnError = err;
        this.emit('exit', undefined, undefined);
      }
    });
  }

  _wireLifecycle() {
    // Deliberately NOT using the 'exit' event here. Node's docs are
    // explicit that 'exit' can fire before the stdio streams have
    // finished delivering their buffered 'data' events — under load this
    // is a real, reproducible race (confirmed via a 25-way concurrent
    // spawn stress test: an 'exit' with code 0 fired while its process's
    // final stdout chunk hadn't been read yet, producing empty captured
    // output). 'close' is documented to fire only after every stdio
    // stream has closed, guaranteeing all 'data' events for this child
    // have already been emitted by the time we synthesize our own exit.
    this._child.on('close', (code, signal) => {
      if (this._exited) return; // already handled via a spawn 'error'
      this._exited = true;
      if (this._flushDecoders) this._flushDecoders();
      if (this._killEscalationTimer) clearTimeout(this._killEscalationTimer);
      this.emit('exit', code === null ? undefined : code, signal || undefined);
    });
  }

  /** node-pty compat: onData(cb) -> disposable */
  onData(cb) {
    this.on('data', cb);
    return { dispose: () => this.removeListener('data', cb) };
  }

  /** node-pty compat: onExit(cb) -> disposable, cb({exitCode, signal}) */
  onExit(cb) {
    const wrapped = (exitCode, signal) => cb({ exitCode, signal });
    this.on('exit', wrapped);
    return { dispose: () => this.removeListener('exit', wrapped) };
  }

  /** Write data to the child's stdin. Silently drops if the child's
   * stdin is no longer writable (e.g. the child already exited) rather
   * than letting a lost write take down the caller. */
  write(data) {
    if (this._exited) return;
    if (this._echo) this.emit('data', data);
    try {
      this._child.stdin.write(data);
    } catch (e) {
      // Stream already destroyed/closed underneath us — see the stdin
      // 'error' handler above for why this can happen even though we
      // checked _exited above (inherent close-vs-exit-event race).
    }
  }

  /**
   * Best-effort resize. Cannot deliver a real SIGWINCH without a pty.
   * Updates internal state and env for informational purposes only;
   * most running programs will not react to this.
   */
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    // No real signal path exists here. Left as a documented limitation
    // rather than silently pretending to succeed.
  }

  /**
   * Kill the child process. If it's still alive after `graceMs` (default
   * 3000ms) — e.g. because it traps or ignores the given signal — escalate
   * to SIGKILL. Pass `{ escalate: false }` to disable this behavior and
   * match node-pty's fire-and-forget semantics exactly.
   */
  kill(signal = 'SIGHUP', opts = {}) {
    if (this._exited) return;
    const graceMs = opts.graceMs != null ? opts.graceMs : 3000;
    const escalate = opts.escalate !== false && signal !== 'SIGKILL';
    this._child.kill(signal);
    if (escalate) {
      this._killEscalationTimer = setTimeout(() => {
        if (!this._exited) this._child.kill('SIGKILL');
      }, graceMs);
      if (this._killEscalationTimer.unref) this._killEscalationTimer.unref();
    }
  }
}

/**
 * spawn(file, args, opts) -> SoftPty
 * Mirrors node-pty's `pty.spawn(...)` factory function.
 */
function spawn(file, args = [], opts = {}) {
  return new SoftPty(file, args, opts);
}

module.exports = { spawn, SoftPty };
