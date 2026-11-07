# Z Feedback

A small Windows app for reviewing a video with a client. The client watches the
video, drops pins on frames, clicks on elements, rates each scene, and (if a
webhook is configured) sends the feedback with one click.

This repository ships with a watermarked demo video so you can try it right away.

## Build and run

1. Install [Rust](https://rustup.rs).
2. Run `build.bat`. It compiles the app and copies the demo video and
   `demo/project.json` next to the exe in `dist\`.
3. Run `dist\ZFeedback.exe`.

## How feedback is sent

Feedback goes to a Discord webhook that is read from `.env` at **build time** and
compiled into the exe. This repository contains **no webhook** on purpose, so a
build from it cannot send anything — "Send feedback" then offers to save the
report as an HTML file instead.

To enable sending, copy `.env.example` to `.env`, put your own webhook in it, and
rebuild:

```
Z_WEBHOOK_URL=https://discord.com/api/webhooks/your-id/your-token
```

Anyone who has the exe can extract a webhook compiled into it, so use a channel
made only for feedback. `.env` is git-ignored and never leaves your machine.

## Use your own video

The exe holds no video. On start it looks next to itself for a video
(`.mp4`, `.m4v`, `.webm`) and an optional `project.json`, and otherwise inside a
`.zip` sitting beside it. To review your own video, replace `demo\video.mp4` and
`demo\project.json`, or drop your video next to the exe.

## project.json

Optional. Without it the whole video is one scene and pins still work anywhere.
With it you get named scenes and clickable elements. See
`examples/project.example.json`.

- `els` entries are `[label, x0, y0, x1, y1]` as fractions of the frame.
- A beat's elements are clickable while paused between its `t0` and `t1`;
  `peek` is the time the scene list jumps to.

The report is a self-contained HTML file with frame thumbnails and the raw data
in `<script id="feedback-data">`.
