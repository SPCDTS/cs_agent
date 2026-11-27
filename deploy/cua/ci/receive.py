#!/usr/bin/python3 -I
"""受限 SSH 发布入口。归档、目标路径和 GitHub 身份均由服务端验证。"""
import base64
import fcntl
import hashlib
import io
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

REPO = "SPCDTS/joule"
UNIT = "cua-directory-bridge.service"
ROOT = Path("/opt/cs-agent/cua")
FILES = {
    "reverse-mcp-bridge.cjs": ROOT / "reverse-mcp-bridge.cjs",
    UNIT: Path("/etc/systemd/system") / UNIT,
}
LIMIT = 8 * 1024 * 1024
READY = Path("/run/cs-agent-cua-bridge/connected")


def github(endpoint):
    url = f"https://api.github.com/repos/{REPO}/{endpoint}"
    with urllib.request.urlopen(url, timeout=10) as response:
        return json.load(response)


def verified_archive(artifact_id, data):
    if not 0 < len(data) <= LIMIT:
        raise ValueError("invalid archive size")
    artifact = github(f"actions/artifacts/{artifact_id}")
    origin = artifact["workflow_run"]
    run = github(f"actions/runs/{int(origin['id'])}")
    head = github("git/ref/heads/main")["object"]["sha"]
    if (artifact["expired"] or artifact["digest"] != "sha256:" + hashlib.sha256(data).hexdigest()
            or not re.fullmatch(r"cua-vps-" + str(run["id"]) + r"-[1-9][0-9]*", artifact["name"])
            or run["path"] != ".github/workflows/ci.yml" or run["event"] not in ("push", "workflow_dispatch")
            or run["head_branch"] != "main" or run["head_repository"]["full_name"].lower() != REPO.lower()
            or run["head_sha"] != head or origin["head_sha"] != head):
        raise ValueError("artifact does not match the trusted main workflow")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        items = archive.infolist()
        if (sorted(item.filename for item in items) != sorted(FILES)
                or any(not 0 < item.file_size <= LIMIT for item in items)):
            raise ValueError("unexpected archive contents")
        files = {item.filename: archive.read(item) for item in items}
    # systemd 以 root 解释 unit，额外比对已合并源码，构建工具只能提供桥程序。
    source = github(f"contents/deploy/cua/{UNIT}?ref={head}")
    if source["encoding"] != "base64" or base64.b64decode(source["content"]) != files[UNIT]:
        raise ValueError("unit does not match the main commit")
    return head, files


def replace(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
        name = Path(tmp.name)
        try:
            tmp.write(data)
            tmp.flush()
            os.fchmod(tmp.fileno(), 0o644)
            os.fsync(tmp.fileno())
            os.replace(name, path)
        finally:
            name.unlink(missing_ok=True)


def systemctl(*args):
    return subprocess.check_output(["systemctl", *args], text=True, timeout=40).strip()


def healthy(expect_connection):
    invocation = systemctl("show", "-p", "InvocationID", "--value", UNIT)
    if not re.fullmatch(r"[0-9a-f]{32}", invocation):
        raise RuntimeError("bridge has no running invocation")
    for _ in range(30):
        for unit in (UNIT, "cua-directory.service"):
            systemctl("is-active", "--quiet", unit)
        if (systemctl("show", "-p", "InvocationID", "--value", UNIT) != invocation
                or not Path("/run/cs-agent-cua/cua.sock").is_socket()):
            raise RuntimeError("bridge restarted or directory socket unavailable")
        if not expect_connection:
            return
        pid = systemctl("show", "-p", "MainPID", "--value", UNIT)
        check = subprocess.run(["runuser", "-u", "cua-directory", "--", "grep", "-Fxq", "--", pid, str(READY)],
                               stderr=subprocess.DEVNULL, timeout=2)
        if pid != "0" and check.returncode == 0:
            return
        time.sleep(2)
    raise RuntimeError("bridge did not connect to the Worker")


def restart():
    systemctl("daemon-reload")
    systemctl("restart", UNIT)


def install(head, files):
    stamp = ROOT / ".ci-release"
    backup = ROOT / ".ci-rollback"
    pending = backup / "pending"
    backup.mkdir(mode=0o700, exist_ok=True)

    def restore():
        for name, path in FILES.items():
            replace(path, (backup / name).read_bytes())
        previous_stamp = (backup / "release").read_bytes()
        restart()
        healthy(bool(previous_stamp))
        if previous_stamp:
            replace(stamp, previous_stamp)
        else:
            stamp.unlink(missing_ok=True)
        pending.unlink()
        print("Previous bridge restored.", file=sys.stderr)

    if pending.exists():
        restore()
    previous = {name: path.read_bytes() for name, path in FILES.items()}
    previous_stamp = stamp.read_bytes() if stamp.exists() else b""
    if previous == files and previous_stamp:
        healthy(True)
        replace(stamp, (head + "\n").encode())
        return
    for name, content in previous.items():
        replace(backup / name, content)
    replace(backup / "release", previous_stamp)
    replace(pending, b"1")
    try:
        for name, path in FILES.items():
            if files[name] != previous[name]:
                replace(path, files[name])
        restart()
        healthy(True)
        replace(stamp, (head + "\n").encode())
        pending.unlink()
    except Exception:
        restore()
        raise


def main():
    signal.alarm(45)
    command = sys.stdin.buffer.readline(64).decode("ascii").removesuffix("\n")
    if command == "probe":
        print("OK cua-vps-deploy v1")
        return
    match = re.fullmatch(r"deploy ([1-9][0-9]{0,19})", command)
    if not match:
        raise ValueError("expected a GitHub artifact ID")
    data = sys.stdin.buffer.read(LIMIT + 1)
    with (ROOT / ".ci-deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        head, files = verified_archive(match[1], data)
        signal.alarm(0)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        install(head, files)
        print(f"OK Cua bridge ready at {head}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.exit(f"Cua deployment failed: {error}")
