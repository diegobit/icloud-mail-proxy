#!/usr/bin/env python3
"""Drive test/setup/prompt-harness.mjs on a real PTY.

argv: node harness_path mode [payload]
mode: text | secret | handoff | eof | cancel
Writes PTY output to stdout; harness JSON goes to $HARNESS_OUT.
"""
import os
import pty
import select
import subprocess
import sys
import time

def read_until(master, needle, timeout):
    buf = b""
    deadline = time.time() + timeout
    while time.time() < deadline:
        wait = max(0.0, deadline - time.time())
        ready, _, _ = select.select([master], [], [], wait)
        if not ready:
            break
        try:
            chunk = os.read(master, 4096)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        if needle in buf:
            break
    return buf


def drain(master, timeout):
    return read_until(master, b"\xff\xff\xff", timeout)


node, harness, mode = sys.argv[1], sys.argv[2], sys.argv[3]
payload = sys.argv[4].encode() if len(sys.argv) > 4 else b""
harness_mode = "text" if mode in ("eof", "cancel") else mode

master, slave = pty.openpty()
proc = subprocess.Popen(
    [node, harness, harness_mode],
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)

output = b""
try:
    if mode == "eof":
        output += read_until(master, b"Your name", 4.0)
        os.write(master, b"\x04")
        output += drain(master, 2.0)
    elif mode == "cancel":
        output += read_until(master, b"Your name", 4.0)
        os.write(master, b"\x03")
        output += drain(master, 1.5)
    elif mode == "secret":
        output += read_until(master, b"Password", 4.0)
        os.write(master, payload or b"s3cret-pass\r")
        output += drain(master, 2.0)
    elif mode == "handoff":
        output += read_until(master, b"Worker name", 4.0)
        os.write(master, b"alpha\r")
        output += read_until(master, b"READY_FOR_CHILD", 4.0)
        os.write(master, b"beta\r")
        output += drain(master, 3.0)
    else:
        output += read_until(master, b":", 4.0)
        os.write(master, payload or b"hello\r")
        output += drain(master, 2.0)
    proc.wait(timeout=10)
except subprocess.TimeoutExpired:
    proc.kill()
    proc.wait()
finally:
    if master is not None:
        try:
            os.close(master)
        except OSError:
            pass

sys.stdout.buffer.write(output)
sys.exit(proc.returncode if proc.returncode is not None else 1)
