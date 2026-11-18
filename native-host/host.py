#!/usr/bin/env python3
import json, os, struct, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
MAPS = os.path.realpath(os.path.join(ROOT, "..", "maps"))
ALLOWED = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")

def allowed_name(name):
    if not isinstance(name, str) or not name.startswith("tanki-map-"):
        return False
    if not (name.endswith(".json") or name.endswith(".png")):
        return False
    if "/" in name or "\\" in name or ".." in name:
        return False
    return all(c in ALLOWED for c in name)

def path_for(name):
    if not allowed_name(name):
        return None
    os.makedirs(MAPS, exist_ok=True)
    full = os.path.realpath(os.path.join(MAPS, name))
    if not full.startswith(MAPS + os.sep) and full != MAPS:
        return None
    return full

def read_msg():
    raw = sys.stdin.buffer.read(4)
    if not raw or len(raw) < 4:
        return None
    (n,) = struct.unpack("<I", raw)
    if n <= 0 or n > 32 * 1024 * 1024:
        return None
    data = sys.stdin.buffer.read(n)
    return json.loads(data.decode("utf-8"))

def write_msg(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()

def handle(msg):
    op = (msg or {}).get("op")
    if op == "ping":
        return {"ok": True, "mapsDir": MAPS}
    if op == "list":
        os.makedirs(MAPS, exist_ok=True)
        names = sorted(n for n in os.listdir(MAPS) if allowed_name(n))
        return {"ok": True, "files": names, "mapsDir": MAPS}
    name = (msg or {}).get("name")
    full = path_for(name) if name else None
    if not full:
        return {"ok": False, "error": "bad name"}
    if op == "read":
        if not os.path.isfile(full):
            return {"ok": False, "error": "missing"}
        with open(full, "r", encoding="utf-8") as f:
            return {"ok": True, "text": f.read()}
    if op == "write":
        text = msg.get("text")
        if not isinstance(text, str):
            return {"ok": False, "error": "no text"}
        os.makedirs(MAPS, exist_ok=True)
        tmp = full + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, full)
        return {"ok": True, "path": full}
    if op == "readB64":
        if not os.path.isfile(full):
            return {"ok": False, "error": "missing"}
        import base64
        with open(full, "rb") as f:
            return {"ok": True, "b64": base64.b64encode(f.read()).decode("ascii")}
    if op == "writeB64":
        import base64
        b64 = msg.get("b64")
        if not isinstance(b64, str):
            return {"ok": False, "error": "no b64"}
        os.makedirs(MAPS, exist_ok=True)
        tmp = full + ".tmp"
        with open(tmp, "wb") as f:
            f.write(base64.b64decode(b64))
        os.replace(tmp, full)
        return {"ok": True, "path": full}
    return {"ok": False, "error": "unknown op"}

def main():
    while True:
        try:
            msg = read_msg()
        except Exception as e:
            write_msg({"ok": False, "error": str(e)})
            return
        if msg is None:
            return
        try:
            write_msg(handle(msg))
        except Exception as e:
            write_msg({"ok": False, "error": str(e)})

if __name__ == "__main__":
    main()
