import os
import json
import sqlite3
from typing import List, Dict, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "change-me")  # set on Render
DB_PATH = os.environ.get("DB_PATH", os.path.join("/tmp", "data.db"))

app = FastAPI()
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

def db_init():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS map_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            state_json TEXT NOT NULL
        )
    """)
    cur.execute("SELECT state_json FROM map_state WHERE id=1")
    row = cur.fetchone()
    if not row:
        empty_state = {"version": 1, "objects": []}  # vector objects
        cur.execute("INSERT INTO map_state (id, state_json) VALUES (1, ?)", (json.dumps(empty_state),))
    con.commit()
    con.close()

def db_get_state() -> Dict[str, Any]:
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute("SELECT state_json FROM map_state WHERE id=1")
    row = cur.fetchone()
    con.close()
    if not row:
        return {"version": 1, "objects": []}
    return json.loads(row[0])

def db_set_state(new_state: Dict[str, Any]) -> None:
    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute("UPDATE map_state SET state_json=? WHERE id=1", (json.dumps(new_state),))
    con.commit()
    con.close()

db_init()

class WSManager:
    def __init__(self):
        self.clients: List[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.clients.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.clients:
            self.clients.remove(ws)

    async def broadcast(self, message: Dict[str, Any]):
        dead = []
        for ws in self.clients:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

ws_manager = WSManager()

@app.get("/")
def root():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

@app.get("/api/state")
def get_state():
    return db_get_state()

@app.post("/api/state")
async def set_state(request: Request):
    # Simple header-based admin auth (fine for a hobby map; not enterprise)
    pwd = request.headers.get("x-admin-password", "")
    if pwd != ADMIN_PASSWORD:
        raise HTTPException(status_code=401, detail="Unauthorized")

    body = await request.json()
    if not isinstance(body, dict) or "objects" not in body:
        raise HTTPException(status_code=400, detail="Invalid state")

    current = db_get_state()
    # bump version so clients can ignore older updates
    new_version = int(current.get("version", 1)) + 1
    body["version"] = new_version

    db_set_state(body)

    # push to all connected viewers
    await ws_manager.broadcast({"type": "state", "state": body})
    return {"ok": True, "version": new_version}

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws_manager.connect(ws)
    try:
        # send current state on connect
        await ws.send_json({"type": "state", "state": db_get_state()})
        while True:
            # Keep alive / ignore incoming
            _ = await ws.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(ws)
    except Exception:
        ws_manager.disconnect(ws)
