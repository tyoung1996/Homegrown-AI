# Circuit Barn

**Private AI for your family, running on an old gaming PC.**

Chat, web search, live weather and scores, long-term memory, and image generation — with accounts for everyone in the house, and nothing leaving it. Built for [The Circuit Barn](https://www.youtube.com/@TheCircuitBarn) on YouTube, where an RTX 2070 Super that had been collecting dust in storage became the family's AI server.

> This is version one. There are bugs. It's free, it's yours, and it's still being built.

### Watch the build

[![I Built My Own ChatGPT on a Dusty Old Gaming PC](https://img.youtube.com/vi/NeipbqHXrW0/maxresdefault.jpg)](https://youtu.be/NeipbqHXrW0)

The whole story, from a dusty PC that wouldn't boot to the family using it: [watch on YouTube](https://youtu.be/NeipbqHXrW0).

## What it does

- **A real app, not a terminal.** Everyone gets a login. Kids get child accounts. Chats and images are private per person.
- **Model library with one-click install.** It reads your GPU and ranks models as *Recommended / Will be slow / Too big for this card*. Pick one, hit Install, watch it download. Switch models any time.
- **An assistant with hands.** Weather, live sports scores, web search that reads the page, and a memory it uses on its own — tell it a birthday once and it knows it in every future chat. Admins can shape its personality from the app.
- **It can see.** Attach a photo and ask about it, restyle it, or put the person into a new scene.
- **The Studio.** Save a few photos of each family member, then put them anywhere: on a dragon, at Hogwarts, in a Ghibli forest. Two quality tiers — a one-minute draft and an Enhance pass with a face detailer that keeps people looking like themselves.
- **A family calendar the assistant keeps.** "Levi has soccer Saturday at 10" puts it on the shared calendar, dates resolved properly ("next Tuesday" means next Tuesday). Ask "what's this weekend?" and it answers from the calendar. Subscribe once from your phone's calendar app and everything the assistant adds shows up there, with a reminder an hour before.
- **Private by construction.** The models only listen on localhost. The API is the only thing allowed to talk to them. Add Tailscale and it works from anywhere without opening a single port.

## What you need

- A PC running **Ubuntu 24.04 or newer** with an **NVIDIA GPU with 8 GB+ of VRAM** (an RTX 2070 Super is the reference machine — plenty). 16 GB RAM. ~40 GB of disk for chat, ~70 GB if you want images.
- The NVIDIA driver installed (`sudo ubuntu-drivers install` then reboot; `nvidia-smi` should show your card).
- Nothing else. The installer handles the rest.

## Install

```bash
git clone https://github.com/tyoung1996/Homegrown-AI.git ~/circuit-barn
cd ~/circuit-barn
./scripts/install.sh
```

That installs Node, PostgreSQL, and Ollama, creates the database, builds both apps, and registers them as services that start on boot. Ten minutes on a normal connection. When it finishes it prints the address — open it from any device on your network.

**First run:** the first account you create becomes the admin. Then the setup screen shows your hardware and the models that fit it. Install one. Chat.

### Image generation (optional, ~25 GB)

```bash
./scripts/install-images.sh
```

Installs ComfyUI with the image model, identity tools (InstantID + ReActor), and the face detailer, then registers it as a service. Afterwards, install the **Vision** extension from the Models panel so the assistant can see photos. Both are optional — the app works without them and simply hides what isn't there.

### Use it away from home

The whole app runs on one port (3000 — the UI proxies the API), so it sits behind anything. Three ways in, all without opening a port on your router:

**Own a domain? Cloudflare Tunnel (recommended — nothing to install on any phone).** Put the domain's DNS on Cloudflare (free plan), then on the server:

```bash
# install cloudflared (https://pkg.cloudflare.com), then:
cloudflared tunnel login                       # approve in your browser, pick the domain
cloudflared tunnel create circuit-barn
cloudflared tunnel route dns circuit-barn ai.yourdomain.com
sudo mkdir -p /etc/cloudflared && sudo cp ~/.cloudflared/*.json ~/.cloudflared/cert.pem /etc/cloudflared/
sudo tee /etc/cloudflared/config.yml >/dev/null <<EOF
tunnel: <the tunnel id from 'cloudflared tunnel list'>
credentials-file: /etc/cloudflared/<that id>.json
ingress:
  - hostname: ai.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
EOF
sudo cloudflared service install && sudo systemctl enable --now cloudflared
```

`https://ai.yourdomain.com` now works from anywhere. The login page is on the internet, so use real passwords — failed logins are rate-limited per account.

**No domain? Tailscale Funnel** gives a free `https://<machine>.<tailnet>.ts.net` address the same way: `sudo tailscale funnel --bg 3000` (it prints a link to enable Funnel on your account the first time). Note: in our testing the public DNS record sometimes took a long time to appear.

**Want it fully private?** Install the [Tailscale](https://tailscale.com) app on the server and on each device; `http://<machine>:3000` then works anywhere, and nothing is reachable from the open internet at all.

## How it's built

```
phones & laptops ──▶ Next.js UI (:3000) ──▶ NestJS API (:3001) ──▶ Ollama (chat, vision)
                                                   │              ──▶ ComfyUI (images)
                                                   └──▶ PostgreSQL (accounts, chats, memories, people)
```

- `ui/` — Next.js app. One page, no framework theatre.
- `api/` — NestJS. Auth (JWT, bcrypt, roles), the chat tool loop, the vision router, the Studio pipeline, the model installer.
- `api/prisma/schema.prisma` — the whole product in one file: User, Conversation, Message, Memory, Person, Setting.
- `api/src/chat/tools.service.ts` — the assistant's hands.
- `api/src/chat/comfy.service.ts` — how a picture actually gets made (scene first, then the face).

Everything runs on one machine as four systemd services: `circuitbarn-ui`, `circuitbarn-api`, `ollama`, `comfyui`.

## Updating

```bash
cd ~/circuit-barn && git pull && ./scripts/install.sh
```

The installer is safe to re-run; it only changes what's out of date.

## Roadmap

Plex requests, home automation, more model families, notifications. Open an issue if something's broken or you want something — the whole point is that this runs in your house, so it should do what your house needs.

## License

MIT. Do what you want with it.
