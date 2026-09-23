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
- **Movie night.** Ask for a film or a show — "add Harry Potter" — and it shows the matches as tick boxes: pick the ones you want, whole seasons, or single episodes. Everything goes on a shared list you can watch progress on, it tells you what you already own, and anything you add to the server's drop folder is renamed, filed and handed to Jellyfin automatically.
- **Put it on the TV.** "I want to watch Harry Potter" — it checks what you own, asks which one and which TV, and plays it. It finds the TVs on your network itself and wakes them from standby.
- **A family calendar the assistant keeps.** "Sam has soccer Saturday at 10" puts it on the shared calendar, dates resolved properly ("next Tuesday" means next Tuesday). Ask "what's this weekend?" and it answers from the calendar. Subscribe once from your phone's calendar app and everything the assistant adds shows up there, with a reminder an hour before.
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

### Movie night (optional)

The library side needs three things in `api/.env`, all optional — the app hides
what isn't configured:

| Setting | What it is |
| --- | --- |
| `TMDB_API_KEY` | Free key from [themoviedb.org](https://www.themoviedb.org/settings/api) so titles can be looked up |
| `JELLYFIN_URL` / `JELLYFIN_API_KEY` | Your [Jellyfin](https://jellyfin.org) server and a key from its Dashboard → API Keys, so the app knows what you already own |
| `MEDIA_ROOT` / `MEDIA_DROPBOX` | The library folder Jellyfin reads, and the folder new files are picked up from |
| `IA_ENABLED` | Optional. `true` switches on the Internet Archive provider, which fetches films whose rights plainly allow it |
| `IA_ALLOWED_IDENTIFIERS` | Optional. Archive item identifiers you have checked yourself and approve, comma separated |
| `ACQUISITION_ORDER` | Optional. Which file provider to prefer, best first, e.g. `tuner,drop-folder`. Anything unnamed goes last |
| `SCREEN_IGNORE` | Optional. Names to leave off the TV list, semicolons between, e.g. `Kitchen speaker; 65" Smart UHD` |
| `SCREEN_NAMES` | Optional. Names your TVs after the rooms they're in, e.g. `55 Roku TV=Front room; Bedroom 2=Nursery` — otherwise they're listed as whatever the TV calls itself |

**How a request becomes a file.** The app keeps the list, the search, the
pickers and the import. Where a file actually comes from is deliberately one
small piece — `api/src/media/acquisition.ts` — and providers live side by
side there: each declares which of MOVIE, SERIES, SEASON and EPISODE it can
handle, and a request goes to the first one that handles its kind and is
working. `ACQUISITION_ORDER` sets which is preferred; one being down never
stops another, or anything else. The built-in provider is a watched folder: put a file you're entitled to copy into `MEDIA_DROPBOX` (a
disc you ripped, a recording, anything you're licensed for) and the app
renames it, files it under `MEDIA_ROOT/Movies` or `MEDIA_ROOT/Shows` the way
Jellyfin expects, marks the request ready to watch, and tells Jellyfin to
rescan. Another source — a TV tuner recording off an antenna, a disc ripper —
implements the same small interface and registers itself; nothing else changes.

**Asking for something you don't have.** Anything the catalogue knows about
can be asked for, whether or not anything on your server can go and fetch
it — a request nobody can fulfil today stays on the list, because that is
what it is: wanted, and not here yet. Ask to watch something that isn't on
the shelf and it says so, and offers to put it on the list — it never
turns "I want to watch X" into a request on its own. Shows are understood
season by season: it can tell you that you have series one and two, that
three is two episodes short and four is missing, and ask for only the gaps.
Ask for one episode and you get one episode, not the whole run.

Something is only ever called **ready to watch** when Jellyfin can actually
see and play it. A file arriving on disk, or anything that fetches it saying
it has finished, gets a request as far as *almost ready* and no further.

**Putting it on the TV.** Say "I want to watch Harry Potter" and it looks
through what you already own, asks which one you meant and which TV, and
starts it. Nothing to configure: the app looks around your own network for
TVs and lists them by the name they already have.

Three kinds of TV work, in the order it prefers them:

| | How it plays | Wakes from standby | Needs setting up |
| --- | --- | --- | --- |
| A Jellyfin app that's already open | Jellyfin tells it to play | already on | no |
| Chromecast, Google TV, a dongle | plays the file straight from Jellyfin | yes | no |
| A TV that speaks UPnP (most Samsung, LG, Sony) | handed the file over UPnP | needs to be on | no |
| Roku | opened straight onto the film in the Jellyfin app | yes | the channel, once |

TVs name themselves things like `55" Roku TV`, which tells nobody which room
that is. `SCREEN_NAMES` maps them onto the names your house uses — pairs
separated by semicolons, `device name=room name` — and both names keep
working, so the name printed on the TV still finds it. Punctuation is
ignored when matching, so leave the inch marks out and save yourself an
argument with systemd about quotes.

**A note on TVs with cast built in.** A Chromecast, a Google TV or a dongle
plugged into any TV all work with nothing to set up. Some TVs advertise cast
but only for their own apps — Samsung's, in particular, will connect, report
its volume, and then ignore a request to play. Those sets usually speak UPnP
instead, which is used in preference wherever a TV offers it, so they work
with nothing installed either. A set that offers neither can be kept off the
list with `SCREEN_IGNORE`.

Roku needs two things done once per TV, and the app will name the TV and the
fix if either is missing:

- **Remote control is off out of the box.** Settings → System → Advanced
  system settings → Control by mobile apps → Network access → **Enabled**
  (older remotes say *Default*). *Limited* is not enough — it accepts the
  harmless commands and refuses the ones that start a film.
- **Install the free Jellyfin channel** from the Roku channel store and sign
  it in once. A Roku is opened straight onto the film, so it gets the same
  subtitles and resume position as everything else. (The *Roku Media Player*
  channel is not a substitute — it takes the launch, opens, and then ignores
  the film.)

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
- `api/prisma/schema.prisma` — the whole product in one file: User, Conversation, Message, Memory, Person, Setting, MediaRequest.
- `api/src/chat/tools.service.ts` — the assistant's hands.
- `api/src/chat/comfy.service.ts` — how a picture actually gets made (scene first, then the face).
- `api/src/media/` — the library list: title lookup, what Jellyfin already has, the drop-folder importer, the TVs on your network, and the one file that decides where a file comes from.

Everything runs on one machine as four systemd services: `circuitbarn-ui`, `circuitbarn-api`, `ollama`, `comfyui`.

## Updating

```bash
cd ~/circuit-barn && git pull && ./scripts/install.sh
```

The installer is safe to re-run; it only changes what's out of date.

## Roadmap

Home automation, more model families, notifications. Open an issue if something's broken or you want something — the whole point is that this runs in your house, so it should do what your house needs.

## License

MIT. Do what you want with it.
