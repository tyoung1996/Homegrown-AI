#!/usr/bin/env bash
# Circuit Barn image generation — ComfyUI plus the models the Studio uses.
# About 25 GB of downloads. Safe to re-run; it skips anything already present.
set -euo pipefail

COMFY="${COMFY_DIR:-$HOME/comfyui}"
APP_USER="$(id -un)"
export DEBIAN_FRONTEND=noninteractive

say()  { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
get()  { # get <url> <dest>
  if [ -s "$2" ]; then ok "$(basename "$2") (already here)"; return; fi
  mkdir -p "$(dirname "$2")"
  echo "  downloading $(basename "$2")…"
  curl -L --progress-bar -o "$2.part" "$1" && mv "$2.part" "$2"
}

say "Python"
sudo apt-get install -y -qq python3-venv python3-pip git >/dev/null
ok "python3-venv"

say "ComfyUI"
if [ ! -d "$COMFY/.git" ]; then
  git clone -q https://github.com/comfyanonymous/ComfyUI "$COMFY"
fi
cd "$COMFY"
[ -d venv ] || python3 -m venv venv
venv/bin/pip -q install --upgrade pip
venv/bin/pip -q install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126
venv/bin/pip -q install -r requirements.txt
# requirements.txt can drag in a cpu-only torchaudio that crashes against cuda torch
venv/bin/pip -q install --force-reinstall --no-deps torchaudio --index-url https://download.pytorch.org/whl/cu126
ok "ComfyUI + PyTorch (CUDA)"

say "Custom nodes: InstantID, ReActor, Impact Pack (face detailer)"
cd "$COMFY/custom_nodes"
[ -d ComfyUI_InstantID ]      || git clone -q https://github.com/cubiq/ComfyUI_InstantID.git
[ -d ComfyUI-ReActor ]        || git clone -q https://github.com/Gourieff/ComfyUI-ReActor.git
[ -d ComfyUI-Impact-Pack ]    || git clone -q https://github.com/ltdrdata/ComfyUI-Impact-Pack.git
[ -d ComfyUI-Impact-Subpack ] || git clone -q https://github.com/ltdrdata/ComfyUI-Impact-Subpack.git
cd "$COMFY"
venv/bin/pip -q install insightface onnxruntime
venv/bin/pip -q install -r custom_nodes/ComfyUI-ReActor/requirements.txt
# sam2 needs a compiler toolchain and isn't used by the face detailer — skip it
grep -viE 'sam2|sam-2' custom_nodes/ComfyUI-Impact-Pack/requirements.txt > /tmp/impact-req.txt
venv/bin/pip -q install -r /tmp/impact-req.txt
venv/bin/pip -q install -r custom_nodes/ComfyUI-Impact-Subpack/requirements.txt
mkdir -p "$COMFY/user/default/ComfyUI-Impact-Subpack"
grep -q face_yolov8m "$COMFY/user/default/ComfyUI-Impact-Subpack/model-whitelist.txt" 2>/dev/null \
  || echo "face_yolov8m.pt" >> "$COMFY/user/default/ComfyUI-Impact-Subpack/model-whitelist.txt"
ok "nodes installed"

say "Models (this is the long part)"
M="$COMFY/models"
get https://huggingface.co/SG161222/RealVisXL_V4.0_Lightning/resolve/main/RealVisXL_V4.0_Lightning.safetensors "$M/checkpoints/RealVisXL_Lightning.safetensors"
get https://huggingface.co/SG161222/RealVisXL_V5.0/resolve/main/RealVisXL_V5.0_fp16.safetensors        "$M/checkpoints/RealVisXL_V5.safetensors"
get https://huggingface.co/TencentARC/PhotoMaker/resolve/main/photomaker-v1.bin                          "$M/photomaker/photomaker-v1.bin"
get https://huggingface.co/InstantX/InstantID/resolve/main/ip-adapter.bin                                "$M/instantid/ip-adapter.bin"
get https://huggingface.co/InstantX/InstantID/resolve/main/ControlNetModel/diffusion_pytorch_model.safetensors "$M/controlnet/instantid-controlnet.safetensors"
for f in 1k3d68.onnx 2d106det.onnx genderage.onnx glintr100.onnx scrfd_10g_bnkps.onnx; do
  get "https://huggingface.co/DIAMONIK7777/antelopev2/resolve/main/$f" "$M/insightface/models/antelopev2/$f"
done
get https://huggingface.co/ezioruan/inswapper_128.onnx/resolve/main/inswapper_128.onnx                   "$M/insightface/inswapper_128.onnx"
get https://github.com/TencentARC/GFPGAN/releases/download/v1.3.4/GFPGANv1.4.pth                         "$M/facerestore_models/GFPGANv1.4.pth"
get https://huggingface.co/Bingsu/adetailer/resolve/main/face_yolov8m.pt                                 "$M/ultralytics/bbox/face_yolov8m.pt"
get https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth                                 "$M/sams/sam_vit_b_01ec64.pth"
if [ ! -f "$M/insightface/models/buffalo_l/det_10g.onnx" ]; then
  get https://huggingface.co/public-data/insightface/resolve/main/models/buffalo_l.zip /tmp/buffalo_l.zip
  mkdir -p "$M/insightface/models/buffalo_l"
  python3 -c "import zipfile; zipfile.ZipFile('/tmp/buffalo_l.zip').extractall('$M/insightface/models/buffalo_l')"
fi
ok "all models present"

say "Service"
sudo tee /etc/systemd/system/comfyui.service >/dev/null <<EOF
[Unit]
Description=ComfyUI image generation
After=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$COMFY
ExecStart=$COMFY/venv/bin/python main.py --listen 127.0.0.1 --port 8188 --disable-smart-memory
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now comfyui >/dev/null
sudo systemctl restart comfyui
sleep 20
if curl -sf -m 10 http://127.0.0.1:8188/system_stats >/dev/null; then
  ok "ComfyUI running on the GPU"
else
  echo "  ComfyUI didn't answer yet — check: journalctl -u comfyui -n 50"
fi

printf '\n\033[1;32mImages are ready.\033[0m Open the app → Models → Extensions → install Vision so the assistant can see photos.\n\n'
