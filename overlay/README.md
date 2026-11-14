# NXBeam overlay

The NXBeam menu in the Switch overlay (Ultrahand / Tesla): pick **USB mode** or **Network mode**, toggle **Screen off while streaming**, then **Restart Switch**. It is built by this repo's workflow and ships inside `NXBeam-Switch.zip` (`switch/.overlays/nxbeam.ovl`).

Build locally with devkitPro:

```bash
cd overlay
git clone --depth 1 https://github.com/WerWolv/libtesla libs/libtesla
make
```

License: GPL-2.0 (libtesla and Tesla-Template by WerWolv).
