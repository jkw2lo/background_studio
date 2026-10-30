"""Offline self-test, run at the end of setup.sh:  python -m app.selftest"""

from __future__ import annotations

import socket
import sys
import time
from pathlib import Path

from . import netguard

netguard.install()

import numpy as np  # noqa: E402

from . import autotag, engine, models  # noqa: E402

models.disable_downloads()


def main() -> int:
    ok = True

    # 1. The network guard blocks outbound traffic but allows this machine.
    try:
        socket.create_connection(("1.1.1.1", 443), timeout=2)
        print("  FAIL network guard did not block an outbound connection")
        ok = False
    except PermissionError:
        print("  ok   outbound connections are blocked inside the app")
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    socket.create_connection(srv.getsockname(), timeout=2).close()
    srv.close()
    print("  ok   localhost connections still work")

    # 2. Each installed model loads from disk and removes a background.
    import skimage

    sample = Path(skimage.__file__).parent / "data" / "astronaut.png"
    img, _ = engine.load_image(sample)
    for name, present in models.installed().items():
        if not present:
            continue
        t0 = time.time()
        session = models.get_session(name)
        cut = engine.remove_background(img, session)
        alpha = np.asarray(cut.getchannel("A"))
        clear, solid = (alpha < 10).mean(), (alpha > 245).mean()
        good = cut.size == img.size and clear > 0.05 and solid > 0.05
        ok &= good
        print(f"  {'ok  ' if good else 'FAIL'} {name}: {clear:.0%} background removed, "
              f"{solid:.0%} kept, {time.time() - t0:.1f}s (incl. model load)")

    # 3. Sort & tag auto-suggest (optional): the astronaut should look more like a person than a stamp.
    if autotag.installed():
        t0 = time.time()
        clip = autotag.Clip()
        names = np.stack([clip.embed_name(n) for n in ("astronaut", "postage stamp", "receipt")])
        prob = autotag.rank(clip.embed_image(autotag.load_small(sample)), names, [None, None, None])
        good = int(prob.argmax()) == 0
        ok &= good
        print(f"  {'ok  ' if good else 'FAIL'} auto-suggest model: {prob[0]:.0%} sure the test picture is an "
              f"astronaut, {time.time() - t0:.1f}s")

    if not any(models.installed().values()):
        print("  FAIL no model installed")
        ok = False
    print("  ok   self-test passed" if ok else "  Self-test FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
