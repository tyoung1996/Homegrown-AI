# Circuit Barn

**Private AI for your family, running on an old gaming PC.**

Chat, web search, live weather and scores, long-term memory, and image generation — with accounts for everyone in the house, and nothing leaving it. Built for [The Circuit Barn](https://www.youtube.com/@TheCircuitBarn) on YouTube, where an RTX 2070 Super that had been collecting dust in storage became the family's AI server.

> This is version one. There are bugs. It's free, it's yours, and it's still being built.

## What it does

- **A real app, not a terminal.** Everyone gets a login. Kids get child accounts. Chats and images are private per person.
- **Model library with one-click install.** It reads your GPU and ranks models as *Recommended / Will be slow / Too big for this card*. Pick one, hit Install, watch it download. Switch models any time.
- **An assistant with hands.** Weather, live sports scores, web search that reads the page, and a memory it uses on its own — tell it a birthday once and it knows it in every future chat. Admins can shape its personality from the app.
- **It can see.** Attach a photo and ask about it, restyle it, or put the person into a new scene.
- **The Studio.** Save a few photos of each family member, then put them anywhere: on a dragon, at Hogwarts, in a Ghibli forest. Two quality tiers — a one-minute draft and an Enhance pass with a face detailer that keeps people looking like themselves.
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

Install [Tailscale](https://tailscale.com) on the server and on your phone (free for personal use). No port forwarding, nothing exposed to the internet:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname circuit-barn
sudo ufw allow in on tailscale0 to any port 3000 proto tcp
sudo ufw allow in on tailscale0 to any port 3001 proto tcp
```

Then `http://circuit-barn:3000` works from anywhere your phone has signal.

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
