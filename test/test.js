'use strict';

const assert = require('assert');
const { spawn } = require('../lib/index.js');

function testEchoesOutput(done) {
  const term = spawn('bash', ['-c', 'echo hello-soft-pty'], {});
  let out = '';
  term.onData((d) => { out += d; });
  term.onExit(({ exitCode }) => {
    assert.strictEqual(exitCode, 0);
    assert.ok(out.includes('hello-soft-pty'), `expected output to include marker, got: ${out}`);
    console.log('ok - testEchoesOutput');
    done();
  });
}

function testWriteToStdin(done) {
  const term = spawn('bash', [], {});
  let out = '';
  term.onData((d) => { out += d; });
  term.write('echo written-via-stdin\n');
  term.write('exit\n');
  term.onExit(() => {
    assert.ok(out.includes('written-via-stdin'), `expected stdin echo, got: ${out}`);
    console.log('ok - testWriteToStdin');
    done();
  });
}

function testResizeIsNonThrowing(done) {
  const term = spawn('bash', ['-c', 'exit 0'], {});
  term.resize(120, 40);
  assert.strictEqual(term.cols, 120);
  assert.strictEqual(term.rows, 40);
  term.onExit(() => {
    console.log('ok - testResizeIsNonThrowing');
    done();
  });
}

function testKill(done) {
  const term = spawn('bash', ['-c', 'sleep 30'], {});
  term.onExit(({ signal }) => {
    console.log('ok - testKill (signal=' + signal + ')');
    done();
  });
  setTimeout(() => term.kill('SIGTERM'), 100);
}

function run(tests) {
  let i = 0;
  function next() {
    if (i >= tests.length) {
      console.log('All tests passed.');
      return;
    }
    const t = tests[i++];
    t(next);
  }
  next();
}

run([testEchoesOutput, testWriteToStdin, testResizeIsNonThrowing, testKill]);
