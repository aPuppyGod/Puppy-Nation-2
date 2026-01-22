const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

const toolSel = document.getElementById("tool");
const sizeEl = document.getElementById("size");
const colorEl = document.getElementById("color");
const detailEl = document.getElementById("detail");

const undoBtn = document.getElementById("undo");
const redoBtn = document.getElementById("redo");
const clearBtn = document.getElementById("clear");

const adminBtn = document.getElementById("adminBtn");
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");

let state = { version: 1, objects: [] };
let undoStack = [];
let redoStack = [];

let adminPassword = localStorage.getItem("ADMIN_PASSWORD") || "";
let isAdmin = false;

// Camera (world -> screen)
let cam = { x: 0, y: 0, zoom: 1 }; // world origin centered later
let isPointerDown = false;
let spaceDown = false;
let pointer = { x: 0, y: 0 };
let startWorld = null;
let currentDraft = null;
let lastPanScreen = null;

// Detail layers (visibility by zoom)
const detailVisibility = {
  continent: { min: 0.05, max: 0.6 },
  country:   { min: 0.4,  max: 3.0 },
  city:      { min: 1.8,  max: 20.0 }
};

function resize() {
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.floor(rect.width * devicePixelRatio);
  canvas.height = Math.floor(rect.height * devicePixelRatio);
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  render();
}
window.addEventListener("resize", resize);
resize();

function setAdmin(on) {
  isAdmin = on;
  adminBtn.textContent = `Admin: ${on ? "On" : "Off"}`;
  saveBtn.disabled = !on;
  statusEl.textContent = on ? "Editing enabled" : "Viewer mode";
  canvas.style.cursor = on ? "crosshair" : "grab";
}

adminBtn.addEventListener("click", () => {
  // Prompt for password (simple; replace with real auth if needed)
  const pwd = prompt("Enter admin password:");
  if (pwd === null) return;
  adminPassword = pwd;
  localStorage.setItem("ADMIN_PASSWORD", pwd);
  // We consider “admin enabled” locally; server validates on save
  setAdmin(true);
});

function worldToScreen(wx, wy) {
  return {
    x: (wx - cam.x) * cam.zoom + canvas.clientWidth / 2,
    y: (wy - cam.y) * cam.zoom + canvas.clientHeight / 2
  };
}
function screenToWorld(sx, sy) {
  return {
    x: (sx - canvas.clientWidth / 2) / cam.zoom + cam.x,
    y: (sy - canvas.clientHeight / 2) / cam.zoom + cam.y
  };
}

function pushUndo() {
  undoStack.push(JSON.stringify(state.objects));
  if (undoStack.length > 50) undoStack.shift();
  redoStack = [];
}

undoBtn.addEventListener("click", () => {
  if (!isAdmin) return;
  if (undoStack.length === 0) return;
  redoStack.push(JSON.stringify(state.objects));
  state.objects = JSON.parse(undoStack.pop());
  render();
});

redoBtn.addEventListener("click", () => {
  if (!isAdmin) return;
  if (redoStack.length === 0) return;
  undoStack.push(JSON.stringify(state.objects));
  state.objects = JSON.parse(redoStack.pop());
  render();
});

clearBtn.addEventListener("click", () => {
  if (!isAdmin) return;
  if (!confirm("Clear the entire map?")) return;
  pushUndo();
  state.objects = [];
  render();
});

saveBtn.addEventListener("click", async () => {
  if (!isAdmin) return;
  statusEl.textContent = "Saving...";
  try {
    const res = await fetch("/api/state", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-password": adminPassword
      },
      body: JSON.stringify({ objects: state.objects })
    });
    if (!res.ok) {
      setAdmin(false);
      throw new Error("Server rejected admin password.");
    }
    const data = await res.json();
    statusEl.textContent = `Saved (v${data.version})`;
  } catch (e) {
    statusEl.textContent = `Save failed: ${e.message}`;
  }
});

// Zoom with wheel (zoom to cursor)
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const delta = -Math.sign(e.deltaY) * 0.12;
  const oldZoom = cam.zoom;

  const mouse = { x: e.offsetX, y: e.offsetY };
  const before = screenToWorld(mouse.x, mouse.y);

  cam.zoom = Math.min(30, Math.max(0.04, cam.zoom * (1 + delta)));
  const after = screenToWorld(mouse.x, mouse.y);

  // keep the world point under cursor stable
  cam.x += (before.x - after.x);
  cam.y += (before.y - after.y);

  if (oldZoom !== cam.zoom) render();
}, { passive: false });

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") spaceDown = true;
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") spaceDown = false;
});

function getVisible(obj) {
  const vis = detailVisibility[obj.detail || "country"];
  if (!vis) return true;
  return cam.zoom >= vis.min && cam.zoom <= vis.max;
}

function drawGrid() {
  // light reference grid in world space
  const step = 200; // world units
  const leftTop = screenToWorld(0, 0);
  const rightBot = screenToWorld(canvas.clientWidth, canvas.clientHeight);

  const startX = Math.floor(leftTop.x / step) * step;
  const endX = Math.floor(rightBot.x / step) * step;
  const startY = Math.floor(leftTop.y / step) * step;
  const endY = Math.floor(rightBot.y / step) * step;

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  for (let x = startX; x <= endX; x += step) {
    const a = worldToScreen(x, startY);
    const b = worldToScreen(x, endY);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  for (let y = startY; y <= endY; y += step) {
    const a = worldToScreen(startX, y);
    const b = worldToScreen(endX, y);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();
}

function render() {
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  drawGrid();

  for (const obj of state.objects) {
    if (!getVisible(obj)) continue;
    drawObject(obj);
  }
  if (currentDraft && getVisible(currentDraft)) {
    drawObject(currentDraft, true);
  }

  // HUD zoom
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = "12px system-ui";
  ctx.fillText(`zoom: ${cam.zoom.toFixed(2)}`, 12, canvas.clientHeight - 12);
  ctx.restore();
}

function drawObject(obj, isDraft = false) {
  ctx.save();
  ctx.globalAlpha = isDraft ? 0.7 : 1;

  const w = Math.max(1, (obj.size || 6) * cam.zoom); // scale stroke with zoom
  ctx.lineWidth = w;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (obj.type === "pen") {
    ctx.strokeStyle = obj.color || "#fff";
    ctx.beginPath();
    for (let i = 0; i < obj.points.length; i++) {
      const p = worldToScreen(obj.points[i].x, obj.points[i].y);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  } else if (obj.type === "eraser") {
    // Eraser as "draw with bg" (simple). Better: true compositing or object delete.
    ctx.strokeStyle = "#0b1020";
    ctx.beginPath();
    for (let i = 0; i < obj.points.length; i++) {
      const p = worldToScreen(obj.points[i].x, obj.points[i].y);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  } else if (obj.type === "rect") {
    ctx.strokeStyle = obj.color || "#fff";
    const a = worldToScreen(obj.x1, obj.y1);
    const b = worldToScreen(obj.x2, obj.y2);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const rw = Math.abs(a.x - b.x);
    const rh = Math.abs(a.y - b.y);
    ctx.strokeRect(x, y, rw, rh);
  } else if (obj.type === "circle") {
    ctx.strokeStyle = obj.color || "#fff";
    const c = worldToScreen(obj.cx, obj.cy);
    const r = obj.r * cam.zoom;
    ctx.beginPath();
    ctx.arc(c.x, c.y, Math.max(1, r), 0, Math.PI * 2);
    ctx.stroke();
  } else if (obj.type === "line") {
    ctx.strokeStyle = obj.color || "#fff";
    const a = worldToScreen(obj.x1, obj.y1);
    const b = worldToScreen(obj.x2, obj.y2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  ctx.restore();
}

// Pointer events
canvas.addEventListener("pointerdown", (e) => {
  pointer = { x: e.offsetX, y: e.offsetY };
  isPointerDown = true;
  canvas.setPointerCapture(e.pointerId);

  const tool = toolSel.value;
  const world = screenToWorld(pointer.x, pointer.y);

  const panMode = (tool === "pan") || spaceDown || !isAdmin;
  if (panMode) {
    lastPanScreen = { x: e.clientX, y: e.clientY };
    return;
  }

  pushUndo();

  const size = Number(sizeEl.value);
  const color = colorEl.value;
  const detail = detailEl.value;

  if (tool === "pen" || tool === "eraser") {
    currentDraft = {
      type: tool === "pen" ? "pen" : "eraser",
      size,
      color,
      detail,
      points: [{ x: world.x, y: world.y }]
    };
  } else if (tool === "rect") {
    startWorld = world;
    currentDraft = { type: "rect", size, color, detail, x1: world.x, y1: world.y, x2: world.x, y2: world.y };
  } else if (tool === "circle") {
    startWorld = world;
    currentDraft = { type: "circle", size, color, detail, cx: world.x, cy: world.y, r: 0 };
  } else if (tool === "line") {
    startWorld = world;
    currentDraft = { type: "line", size, color, detail, x1: world.x, y1: world.y, x2: world.x, y2: world.y };
  } else if (tool === "fill") {
    // Fill works in SCREEN space on the rendered image (raster)
    bucketFill(e.offsetX, e.offsetY, color);
    // Save fill as a “stamp” by converting the whole current view to an image is complex,
    // so for MVP we just apply it visually and you should save right after.
    // Better approach: store raster tiles or store fills as polygons (hard).
    state.objects.push({ type: "note", detail, meta: "fill-applied" });
    currentDraft = null;
  }

  render();
});

canvas.addEventListener("pointermove", (e) => {
  pointer = { x: e.offsetX, y: e.offsetY };

  if (!isPointerDown) return;

  const tool = toolSel.value;
  const world = screenToWorld(pointer.x, pointer.y);

  const panMode = (tool === "pan") || spaceDown || !isAdmin;
  if (panMode) {
    if (!lastPanScreen) return;
    const dx = e.clientX - lastPanScreen.x;
    const dy = e.clientY - lastPanScreen.y;
    cam.x -= dx / cam.zoom;
    cam.y -= dy / cam.zoom;
    lastPanScreen = { x: e.clientX, y: e.clientY };
    render();
    return;
  }

  if (!currentDraft) return;

  if (currentDraft.type === "pen" || currentDraft.type === "eraser") {
    currentDraft.points.push({ x: world.x, y: world.y });
  } else if (currentDraft.type === "rect") {
    currentDraft.x2 = world.x;
    currentDraft.y2 = world.y;
  } else if (currentDraft.type === "line") {
    currentDraft.x2 = world.x;
    currentDraft.y2 = world.y;
  } else if (currentDraft.type === "circle") {
    const dx = world.x - startWorld.x;
    const dy = world.y - startWorld.y;
    currentDraft.r = Math.sqrt(dx * dx + dy * dy);
  }

  render();
});

canvas.addEventListener("pointerup", (e) => {
  isPointerDown = false;
  lastPanScreen = null;

  if (!isAdmin) return;
  if (!currentDraft) return;

  // Commit draft (ignore tiny strokes)
  if ((currentDraft.type === "pen" || currentDraft.type === "eraser") && currentDraft.points.length < 2) {
    currentDraft = null;
    render();
    return;
  }

  state.objects.push(currentDraft);
  currentDraft = null;
  render();
});

// --- Simple flood fill in screen pixels ---
function hexToRgba(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0,2), 16);
  const g = parseInt(h.substring(2,4), 16);
  const b = parseInt(h.substring(4,6), 16);
  return [r,g,b,255];
}
function matchColor(data, idx, target) {
  return data[idx] === target[0] && data[idx+1] === target[1] && data[idx+2] === target[2] && data[idx+3] === target[3];
}
function setColor(data, idx, color) {
  data[idx] = color[0]; data[idx+1] = color[1]; data[idx+2] = color[2]; data[idx+3] = color[3];
}
function bucketFill(sx, sy, hexColor) {
  // Render first so fill uses up-to-date pixels
  render();

  const w = Math.floor(canvas.clientWidth);
  const h = Math.floor(canvas.clientHeight);

  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;

  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return;

  const idx0 = (y0 * w + x0) * 4;
  const target = [data[idx0], data[idx0+1], data[idx0+2], data[idx0+3]];
  const fill = hexToRgba(hexColor);

  // if target already equals fill, stop
  if (target[0] === fill[0] && target[1] === fill[1] && target[2] === fill[2] && target[3] === fill[3]) return;

  const stack = [[x0, y0]];
  while (stack.length) {
    const [x, y] = stack.pop();
    const idx = (y * w + x) * 4;
    if (!matchColor(data, idx, target)) continue;

    setColor(data, idx, fill);

    if (x > 0) stack.push([x-1, y]);
    if (x < w-1) stack.push([x+1, y]);
    if (y > 0) stack.push([x, y-1]);
    if (y < h-1) stack.push([x, y+1]);
  }

  ctx.putImageData(img, 0, 0);
}

// --- Live updates via WebSocket ---
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    // keepalive ping
    setInterval(() => {
      try { ws.send("ping"); } catch {}
    }, 25000);
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state" && msg.state) {
        // If admin is actively editing, don’t clobber local draft.
        // But if you want true collaboration, you’d merge instead.
        state = msg.state;
        render();
      }
    } catch {}
  };

  ws.onclose = () => {
    setTimeout(connectWS, 1500);
  };
}
connectWS();

// Start as viewer
setAdmin(false);
