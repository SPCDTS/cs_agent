#!/usr/bin/python3 -I
"""普通发布账号的登录 shell，只能与本机发布套接字交换一份归档。"""
import os
import re
import signal
import socket
import sys


def main():
    command = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    if command != "probe" and not re.fullmatch(r"deploy [1-9][0-9]{0,19}", command):
        raise ValueError("unsupported release command")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
        signal.alarm(60)
        channel.connect("/run/cs-agent-cua-deploy.sock")
        channel.sendall((command + "\n").encode())
        if command != "probe":
            limit = 8 * 1024 * 1024
            data = sys.stdin.buffer.read(limit + 1)
            if not 0 < len(data) <= limit:
                raise ValueError("invalid archive size")
            channel.sendall(data)
        channel.shutdown(socket.SHUT_WR)
        signal.alarm(0)
        channel.settimeout(320)
        with channel.makefile("rb") as result:
            reply = result.readline(256)
        if not re.fullmatch(rb"OK (cua-vps-deploy v1|Cua bridge ready at [0-9a-f]{40})\n", reply):
            raise RuntimeError("release rejected or failed; check the VPS deployment journal")
        print(reply.decode().strip())


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.exit(str(error))
