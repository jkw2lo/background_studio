"""Process-wide network guard.

Once installed, any attempt by Python code in this process (our code or any
library) to resolve a hostname or open a connection to anything other than this
computer's loopback interface raises PermissionError and is recorded.

This is defence in depth: the app never makes network requests on purpose, and
model weights are only downloaded by setup.sh, which does not use this guard.
"""

from __future__ import annotations

import ipaddress
import socket
import threading
import time

_LOCAL_NAMES = {"localhost", "localhost.", "ip6-localhost", "ip6-loopback"}

_lock = threading.Lock()
_blocked: list[dict] = []
_installed = False


def _is_loopback_host(host) -> bool:
    if host is None:  # getaddrinfo(None, port) means "this machine" (used for binding)
        return True
    if isinstance(host, bytes):
        host = host.decode("ascii", "ignore")
    host = str(host).strip("[]").split("%", 1)[0]
    if host.lower() in _LOCAL_NAMES or host == "":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _record(kind: str, target) -> None:
    with _lock:
        _blocked.append({"time": time.time(), "kind": kind, "target": repr(target)[:200]})


def _guard_address(sock: socket.socket, address, kind: str) -> None:
    if sock.family == getattr(socket, "AF_UNIX", object()):
        return
    host = address[0] if isinstance(address, tuple) else address
    if not _is_loopback_host(host):
        _record(kind, address)
        raise PermissionError(
            f"Background Studio blocked a network connection to {address!r}: "
            "the app only talks to this computer."
        )


def install() -> None:
    """Patch the socket module. Safe to call more than once."""
    global _installed
    if _installed:
        return

    orig_connect = socket.socket.connect
    orig_connect_ex = socket.socket.connect_ex
    orig_sendto = socket.socket.sendto
    orig_getaddrinfo = socket.getaddrinfo
    orig_gethostbyname = socket.gethostbyname
    orig_gethostbyname_ex = socket.gethostbyname_ex

    def connect(self, address):
        _guard_address(self, address, "connect")
        return orig_connect(self, address)

    def connect_ex(self, address):
        _guard_address(self, address, "connect")
        return orig_connect_ex(self, address)

    def sendto(self, data, *args):
        address = args[-1]
        _guard_address(self, address, "sendto")
        return orig_sendto(self, data, *args)

    def getaddrinfo(host, *args, **kwargs):
        if not _is_loopback_host(host):
            _record("dns", host)
            raise PermissionError(f"Background Studio blocked a DNS lookup for {host!r}.")
        return orig_getaddrinfo(host, *args, **kwargs)

    def gethostbyname(host):
        if not _is_loopback_host(host):
            _record("dns", host)
            raise PermissionError(f"Background Studio blocked a DNS lookup for {host!r}.")
        return orig_gethostbyname(host)

    def gethostbyname_ex(host):
        if not _is_loopback_host(host):
            _record("dns", host)
            raise PermissionError(f"Background Studio blocked a DNS lookup for {host!r}.")
        return orig_gethostbyname_ex(host)

    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex
    socket.socket.sendto = sendto
    socket.getaddrinfo = getaddrinfo
    socket.gethostbyname = gethostbyname
    socket.gethostbyname_ex = gethostbyname_ex
    _installed = True


def status() -> dict:
    with _lock:
        return {"active": _installed, "blocked": len(_blocked), "recent": _blocked[-5:]}
