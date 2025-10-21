from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path

from database import Base, engine, SessionLocal
from models import Mesa, Producto
from routes import ordenes, productos
from routes import finanzas

class OrderWebSocketManager:
    def __init__(self):
        self.active = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active:
            self.active.remove(websocket)

    async def broadcast(self, data: dict):
        for ws in list(self.active):
            try:
                await ws.send_json(data)
            except Exception:
                # On error, drop connection
                self.disconnect(ws)

app = FastAPI()

# CORS para permitir la app del frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174"],
    allow_origin_regex=r"http://.*:517\d",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

manager = OrderWebSocketManager()
app.state.order_manager = manager

# Rutas
app.include_router(productos.router)
app.include_router(ordenes.router)
app.include_router(finanzas.router)

# Servir frontend (SPA) desde FastAPI si existe el build
FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if FRONTEND_DIST.exists():
    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    vite_icon = FRONTEND_DIST / "vite.svg"

    @app.get("/")
    async def index():
        index_file = FRONTEND_DIST / "index.html"
        if index_file.exists():
            return FileResponse(index_file)
        return {"detail": "Not Found"}

    @app.get("/vite.svg")
    async def vite_svg():
        if vite_icon.exists():
            return FileResponse(vite_icon)
        return {"detail": "Not Found"}


@app.on_event("startup")
def startup():
    # Crear tablas y sembrar datos si no existen
    Base.metadata.create_all(bind=engine)
    # Migración ligera: añadir columna 'entregado' y 'entregados' a orden_detalle si no existen
    from sqlalchemy import text
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("ALTER TABLE orden_detalle ADD COLUMN entregado INTEGER DEFAULT 0")
    except Exception:
        # Si ya existe o SQLite no permite, ignorar
        pass
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("ALTER TABLE orden_detalle ADD COLUMN entregados INTEGER DEFAULT 0")
    except Exception:
        # Si ya existe o SQLite no permite, ignorar
        pass

    db = SessionLocal()
    try:
        if db.query(Mesa).count() == 0:
            mesas = [Mesa(numero=i) for i in range(1, 4)]
            db.add_all(mesas)
            db.commit()
        if db.query(Producto).count() == 0:
            productos_seed = [
                Producto(nombre="Pizza Margherita", precio=8.99, imagen="https://picsum.photos/seed/pizza/200"),
                Producto(nombre="Hamburguesa", precio=9.49, imagen="https://picsum.photos/seed/burger/200"),
                Producto(nombre="Ensalada César", precio=7.25, imagen="https://picsum.photos/seed/salad/200"),
                Producto(nombre="Pasta Boloñesa", precio=10.75, imagen="https://picsum.photos/seed/pasta/200"),
                Producto(nombre="Tacos Al Pastor", precio=6.50, imagen="https://picsum.photos/seed/tacos/200"),
            ]
            db.add_all(productos_seed)
            db.commit()
    finally:
        db.close()


@app.websocket("/ws/ordenes")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()  # mantener conexión abierta
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# Fallback SPA: servir index.html para rutas no API
@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    if FRONTEND_DIST.exists():
        index_file = FRONTEND_DIST / "index.html"
        if index_file.exists():
            return FileResponse(index_file)
    return {"detail": "Not Found"}