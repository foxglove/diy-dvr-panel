# DiyDvrExtension version history

## 0.1.0

- Initial spin-out from the DIY DVR spike.
- Web Worker capture pipeline: subscribe to live topics, JSON-encode messages (real schemas from the SDK / bundled ROS2 defs, base64 byte arrays), frame to a fully indexed MCAP.
- Dump-on-demand: write the buffer to an `.mcap` file for full scrub-back in a new tab.
