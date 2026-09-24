import getpass
import re
import sys
from pathlib import Path

import hashlib
import hmac
import random


def read_seed(hidden: bool = True, prompt: str = "") -> int | str:
    try:
        if not hidden:
            value = input(prompt)
        else:
            value = getpass.getpass(prompt) if sys.stdin.isatty() else sys.stdin.readline().rstrip("\r\n")
    except (EOFError, KeyboardInterrupt):
        raise ValueError("R01") from None
    if not value.strip():
        raise ValueError("R02")
    try:
        return int(value.strip())
    except ValueError:
        return value


def shift(data: bytes, seed: int | str, reverse=False) -> bytes:
    rng = random.Random(seed)
    direction = -1 if reverse else 1
    return bytes(
        32 + (value - 32 + direction * rng.randint(1, 94)) % 95
        if 32 <= value <= 126 else value
        for value in data
    )


def pack(data: bytes, seed: int | str) -> bytes:
    digest = hashlib.sha256(data).hexdigest().encode("ascii")
    return shift(b"TOMASI-SEED-1\n" + digest + b"\n" + data, seed)


def unpack(data: bytes, seed: int | str) -> bytes:
    parts = shift(data, seed, reverse=True).split(b"\n", 2)
    if (len(parts) != 3 or parts[0] != b"TOMASI-SEED-1"
            or not hmac.compare_digest(parts[1], hashlib.sha256(parts[2]).hexdigest().encode("ascii"))):
        raise ValueError("R03")
    return parts[2]


def decode(data: bytes) -> bytes:
    if not data:
        return b""
    if not data.endswith(b"\t"):
        raise ValueError("R04")
    groups = data[:-1].split(b"\t")
    if len(groups) % 2:
        raise ValueError("R05")
    values = []
    for group in groups:
        if not 1 <= len(group) <= 16 or group != b" " * len(group):
            raise ValueError("R06")
        values.append(len(group) - 1)
    return bytes((values[i] << 4) | values[i + 1]
                 for i in range(0, len(values), 2))


if __name__ == "__main__":
    if len(sys.argv) != 1:
        sys.exit("R07")
    source = Path(__file__).resolve().with_name("README.md")

    try:
        original = source.read_bytes()
        matches = re.findall(rb"^\t{3}((?: {1,16}\t {1,16}\t)+)\r?$", original, re.MULTILINE)
        if not matches:
            raise ValueError("R08")
        result = unpack(decode(b"".join(matches)), read_seed())
    except ValueError as exc:
        sys.exit(str(exc))
    except OSError:
        sys.exit("R09")

    name = str(source.with_name("main.py"))
    sys.argv = [name]
    exec(compile(result, name, "exec"), {"__name__": "__main__", "__file__": name})
