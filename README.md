# Web Whiteboard Signaling Worker

Cloudflare Workers + Durable Objects based signaling server for Yjs.

## WebSocket URLs

- Query format: `wss://<worker-domain>/websocket?room=<room>&passcode=<passcode>`
- Path format: `wss://<worker-domain>/websocket/<room>?passcode=<passcode>`

`room` is required. `passcode` is optional; the first connection sets it for the room.

## Health Check

- `GET /` returns `200 OK`

## Deploy

```sh
wrangler deploy
```

## AI Proxy (Optional)

Set a secret for Gemini in the Worker environment:

```sh
wrangler secret put GEMINI_API_KEY
```

AI endpoints:
- `POST /ai/brainstorm`
- `POST /ai/analyze`
