from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse, Response
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
import io
import zipfile
import qrcode
import os
import json
import datetime

from database import get_db
from models import Mesa, Orden, OrdenDetalle, Producto, Pago
from qrcode.image.styledpil import StyledPilImage
from qrcode.image.styles.moduledrawers import SquareModuleDrawer, RoundedModuleDrawer, CircleModuleDrawer, GappedSquareModuleDrawer
from qrcode.image.styles.colormasks import SolidFillColorMask
from PIL import Image, ImageDraw, ImageFont
import urllib.request
from groq import Groq

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _recommended_base_url(request: Request) -> str:
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("host", request.url.netloc)
    return f"{scheme}://{host}/orden?mesa="


class QrConfigOut(BaseModel):
    base_url: str
    total_mesas: int


@router.get("/qr/config", response_model=QrConfigOut)
def get_qr_config(request: Request, db: Session = Depends(get_db)):
    base = _recommended_base_url(request)
    try:
        total = db.query(Mesa).count()
    except Exception:
        total = 0
    return QrConfigOut(base_url=base, total_mesas=total)


def _parse_hex_color(s: str, default=(0, 0, 0)) -> tuple[int, int, int]:
    try:
        v = s.strip()
        if v.startswith('#'):
            v = v[1:]
        if len(v) == 3:
            r = int(v[0] * 2, 16)
            g = int(v[1] * 2, 16)
            b = int(v[2] * 2, 16)
        elif len(v) == 6:
            r = int(v[0:2], 16)
            g = int(v[2:4], 16)
            b = int(v[4:6], 16)
        else:
            return default
        return (r, g, b)
    except Exception:
        return default


def _build_png(
    data: str,
    *,
    style: str = 'square',
    fill: str = '#000000',
    back: str = '#FFFFFF',
    gradient: str = 'none',
    logo_url: str | None = None,
    label: str | None = None,
    label_pos: str = 'bottom',
    label_color: str = '#000000',
    label_style: str = 'plain',
    label_bg: str = '#000000',
) -> bytes:
    # Configure module style
    drawer_map = {
        'square': SquareModuleDrawer(),
        'rounded': RoundedModuleDrawer(),
        'circle': CircleModuleDrawer(),
        'gapped_square': GappedSquareModuleDrawer(),
    }
    module_drawer = drawer_map.get(style, SquareModuleDrawer())

    # Configure color mask
    mask = SolidFillColorMask(
        back_color=_parse_hex_color(back, (255, 255, 255)),
        front_color=_parse_hex_color(fill, (0, 0, 0)),
    )

    # Build QR code image
    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        border=4,
        box_size=10,
    )
    qr.add_data(data)
    qr.make(fit=True)
    img_obj = qr.make_image(
        image_factory=StyledPilImage,
        module_drawer=module_drawer,
        color_mask=mask,
    )
    img = img_obj.get_image().convert('RGBA')

    # Optional logo overlay (center)
    if logo_url:
        try:
            with urllib.request.urlopen(logo_url, timeout=5) as resp:
                logo_bytes = resp.read()
            import io as _io
            logo = Image.open(_io.BytesIO(logo_bytes)).convert('RGBA')
            max_w = img.width // 4
            aspect = logo.height / logo.width if logo.width else 1
            logo = logo.resize((max_w, int(max_w * aspect)), Image.LANCZOS)
            pos = ((img.width - logo.width) // 2, (img.height - logo.height) // 2)
            img.alpha_composite(logo, dest=pos)
        except Exception:
            # Silently ignore logo errors for robustness
            pass

    # Optional label/text (top, bottom or center) with style support
    if label:
        font = ImageFont.load_default()
        draw_tmp = ImageDraw.Draw(img)
        bbox = draw_tmp.textbbox((0, 0), label, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]
        pad_x, pad_y = 12, 8
        tc = _parse_hex_color(label_color, (0, 0, 0))
        bg_rgb = _parse_hex_color(back, (255, 255, 255))
        banner_bg = _parse_hex_color(label_bg, (0, 0, 0))

        if label_style == 'banner' and label_pos in ('bottom', 'top'):
            banner_h = text_h + pad_y * 3
            canvas_h = img.height + banner_h
            canvas = Image.new('RGBA', (img.width, canvas_h), (*bg_rgb, 255))
            draw_canvas = ImageDraw.Draw(canvas)
            if label_pos == 'top':
                # Banner at top with downward notch
                draw_canvas.rounded_rectangle([0, 0, img.width, banner_h], radius=12, fill=(*banner_bg, 255))
                notch_w = max(12, img.width // 12)
                notch_h = notch_w // 2
                cx = img.width // 2
                draw_canvas.polygon([(cx - notch_w // 2, banner_h), (cx, banner_h + notch_h), (cx + notch_w // 2, banner_h)], fill=(*banner_bg, 255))
                draw_canvas.text(((img.width - text_w) // 2, (banner_h - text_h) // 2), label, fill=(*tc, 255), font=font)
                canvas.paste(img, (0, banner_h))
            else:
                # Banner at bottom with upward notch
                canvas.paste(img, (0, 0))
                y0 = img.height
                y1 = img.height + banner_h
                draw_canvas.rounded_rectangle([0, y0, img.width, y1], radius=12, fill=(*banner_bg, 255))
                notch_w = max(12, img.width // 12)
                notch_h = notch_w // 2
                cx = img.width // 2
                draw_canvas.polygon([(cx - notch_w // 2, y0), (cx, y0 - notch_h), (cx + notch_w // 2, y0)], fill=(*banner_bg, 255))
                draw_canvas.text(((img.width - text_w) // 2, y0 + (banner_h - text_h) // 2), label, fill=(*tc, 255), font=font)
            img = canvas
        elif label_pos == 'center':
            # Semi-transparent rounded badge centered
            badge_w = text_w + pad_x * 2
            badge_h = text_h + pad_y * 2
            badge = Image.new('RGBA', (badge_w, badge_h), (0, 0, 0, 0))
            bd = ImageDraw.Draw(badge)
            bd.rounded_rectangle([0, 0, badge_w, badge_h], radius=8, fill=(*banner_bg, 210))
            bd.text((pad_x, pad_y), label, fill=(*tc, 255), font=font)
            pos = ((img.width - badge_w) // 2, (img.height - badge_h) // 2)
            img.alpha_composite(badge, dest=pos)
        else:
            # Plain text top/bottom
            pad = 8
            canvas_h = img.height + text_h + pad * 2
            canvas = Image.new('RGBA', (img.width, canvas_h), (*bg_rgb, 255))
            draw_canvas = ImageDraw.Draw(canvas)
            if label_pos == 'top':
                draw_canvas.text(((img.width - text_w) // 2, pad), label, fill=(*tc, 255), font=font)
                canvas.paste(img, (0, text_h + pad * 2))
            else:
                canvas.paste(img, (0, 0))
                draw_canvas.text(((img.width - text_w) // 2, img.height + pad), label, fill=(*tc, 255), font=font)
            img = canvas

    out = io.BytesIO()
    img.save(out, format='PNG')
    return out.getvalue()


@router.get("/qr/mesa/{mesa_numero}")
def preview_qr(
    mesa_numero: int,
    request: Request,
    base_url: str | None = None,
    style: str = 'square',
    fill: str = '#000000',
    back: str = '#FFFFFF',
    gradient: str = 'none',
    logo_url: str | None = None,
    label: str | None = None,
    label_pos: str = 'bottom',
    label_color: str = '#000000',
    label_style: str = 'plain',
    label_bg: str = '#000000',
):
    base = base_url or _recommended_base_url(request)
    if not base:
        raise HTTPException(status_code=400, detail="base_url requerido")
    png = _build_png(
        f"{base}{mesa_numero}",
        style=style,
        fill=fill,
        back=back,
        gradient=gradient,
        logo_url=logo_url,
        label=label,
        label_pos=label_pos,
        label_color=label_color,
        label_style=label_style,
        label_bg=label_bg,
    )
    headers = {"Content-Disposition": f'inline; filename="mesa_{mesa_numero}.png"'}
    return Response(content=png, media_type="image/png", headers=headers)


class QrGenRequest(BaseModel):
    base_url: str = Field(..., min_length=1)
    total_mesas: int = Field(..., ge=1, le=10000)
    filename: str | None = None
    style: str | None = 'square'
    fill: str | None = '#000000'
    back: str | None = '#FFFFFF'
    gradient: str | None = 'none'
    logo_url: str | None = None
    label: str | None = None
    label_pos: str | None = 'bottom'
    label_color: str | None = '#000000'
    label_style: str | None = 'plain'
    label_bg: str | None = '#000000'


@router.post("/qr/generar")
def generar_qr_zip(req: QrGenRequest):
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        for mesa in range(1, req.total_mesas + 1):
            data = f"{req.base_url}{mesa}"
            png = _build_png(
                data,
                style=(req.style or 'square'),
                fill=(req.fill or '#000000'),
                back=(req.back or '#FFFFFF'),
                gradient=(req.gradient or 'none'),
                logo_url=req.logo_url,
                label=req.label,
                label_pos=(req.label_pos or 'bottom'),
                label_color=(req.label_color or '#000000'),
                label_style=(req.label_style or 'plain'),
                label_bg=(req.label_bg or '#000000'),
            )
            zf.writestr(f"mesa_{mesa}.png", png)
    zip_buf.seek(0)
    fname = req.filename or "qr_mesas.zip"
    headers = {"Content-Disposition": f'attachment; filename="{fname}"'}
    return StreamingResponse(zip_buf, media_type="application/zip", headers=headers)


class VoiceCommandIn(BaseModel):
    text: str


class VoiceOperation(BaseModel):
    type: str
    order_id: int | None = None
    mesa_numero: int | None = None
    producto_nombre: str | None = None
    cantidad: int | None = None
    estado: str | None = None


class VoiceCommandOut(BaseModel):
    spoken_response: str
    operations: list[VoiceOperation]


def _active_orders(db: Session) -> list[Orden]:
    orders = db.query(Orden).order_by(Orden.fecha.asc()).all()
    visibles = [o for o in orders if db.query(Pago).filter(Pago.orden_id == o.id).first() is None]
    return visibles


def _serialize_orders_for_ai(orders: list[Orden]) -> list[dict]:
    now = datetime.datetime.now(datetime.timezone.utc)
    data: list[dict] = []
    for o in orders:
        mesa = o.mesa.numero if o.mesa else None
        age_min = int((now - o.fecha).total_seconds() // 60)
        items: list[dict] = []
        for d in o.detalles:
            nombre = d.producto.nombre if d.producto else ""
            entregados = int(getattr(d, "entregados", 0))
            faltan = max(0, d.cantidad - entregados)
            items.append(
                {
                    "producto_id": d.producto_id,
                    "nombre": nombre,
                    "cantidad": d.cantidad,
                    "entregados": entregados,
                    "faltan": faltan,
                }
            )
        data.append(
            {
                "orden_id": o.id,
                "mesa_numero": mesa,
                "estado": o.estado,
                "edad_minutos": age_min,
                "items": items,
            }
        )
    return data


def _ensure_groq_client() -> Groq:
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="Falta configurar GROQ_API_KEY en el entorno del servidor")
    return Groq(api_key=api_key)


def _parse_ai_response(raw: str) -> dict:
    try:
        return json.loads(raw)
    except Exception:
        try:
            start = raw.find("{")
            end = raw.rfind("}")
            if start != -1 and end != -1 and end > start:
                return json.loads(raw[start : end + 1])
        except Exception:
            return {}
    return {}


def _build_status_summary(orders_for_ai: list[dict]) -> str:
    if not orders_for_ai:
        return "No hay órdenes activas ahorita."
    pendientes: list[dict] = []
    for o in orders_for_ai:
        faltan_total = sum(int(it.get("faltan") or 0) for it in o.get("items") or [])
        if faltan_total > 0:
            pendientes.append(o)
    if not pendientes:
        return "No hay nada pendiente en cocina, todo está entregado."
    if len(pendientes) == 1:
        o = pendientes[0]
        mesa = o.get("mesa_numero") or "desconocida"
        oid = o.get("orden_id") or ""
        items_desc: list[str] = []
        total_faltan = 0
        for it in o.get("items") or []:
            faltan = int(it.get("faltan") or 0)
            if faltan <= 0:
                continue
            total_faltan += faltan
            nombre = str(it.get("nombre") or "").lower()
            if nombre and not nombre.startswith("taco") and "taco" in nombre:
                nombre = "tacos " + nombre
            unidad = "pieza" if faltan == 1 else "ítems"
            items_desc.append(f"{faltan} {nombre or unidad}")
        if not items_desc:
            return f"Tienes pendiente una sola orden: la de la mesa {mesa}, pedido #{oid}. Está casi lista."
        lista = ", ".join(items_desc[:-1]) + (" y " + items_desc[-1] if len(items_desc) > 1 else items_desc[0])
        return (
            f"Tienes pendiente una sola orden: la de la mesa {mesa}, pedido #{oid}. "
            f"Ahí faltan en total {total_faltan} ítems por preparar: {lista}. "
            "Ya casi está."
        )
    total_ordenes = len(pendientes)
    total_items = 0
    for o in pendientes:
        for it in o.get("items") or []:
            total_items += int(it.get("faltan") or 0)
    primera = pendientes[0]
    mesa = primera.get("mesa_numero") or "desconocida"
    oid = primera.get("orden_id") or ""
    faltan_primera = sum(int(it.get("faltan") or 0) for it in primera.get("items") or [])
    return (
        f"Tienes {total_ordenes} órdenes pendientes en cocina, con {total_items} ítems por preparar en total. "
        f"La más vieja es la de la mesa {mesa}, pedido #{oid}, donde faltan {faltan_primera} piezas. "
        "Organiza la plancha para sacar primero esa orden."
    )


def _find_open_order_for_mesa(db: Session, mesa_numero: int) -> Orden | None:
    mesa = db.query(Mesa).filter(Mesa.numero == mesa_numero).first()
    if not mesa:
        return None
    orders = (
        db.query(Orden)
        .filter(Orden.mesa_id == mesa.id)
        .order_by(Orden.fecha.desc())
        .all()
    )
    for o in orders:
        if db.query(Pago).filter(Pago.orden_id == o.id).first() is None:
            return o
    return None


def _apply_voice_operations(ops: list[dict], request: Request, db: Session) -> list[VoiceOperation]:
    applied: list[VoiceOperation] = []
    for op in ops:
        t = str(op.get("type") or "").lower()
        if t == "query_status":
            applied.append(VoiceOperation(type="query_status"))
        elif t == "set_order_state_by_id":
            order_id = op.get("order_id")
            estado = op.get("estado")
            if isinstance(order_id, int) and isinstance(estado, str):
                order = db.get(Orden, order_id)
                if not order:
                    continue
                order.estado = estado
                db.commit()
                db.refresh(order)
                try:
                    request.app.state.order_manager.broadcast(
                        {"type": "update_status", "order": {"id": order.id, "estado": order.estado}}
                    )
                except Exception:
                    pass
                applied.append(
                    VoiceOperation(
                        type="set_order_state_by_id",
                        order_id=order.id,
                        estado=order.estado,
                    )
                )
        elif t == "increment_items_ready_by_name":
            mesa_numero = op.get("mesa_numero")
            producto_nombre = op.get("producto_nombre")
            cantidad = op.get("cantidad")
            if not (isinstance(mesa_numero, int) and isinstance(producto_nombre, str) and isinstance(cantidad, int)):
                continue
            order = _find_open_order_for_mesa(db, mesa_numero)
            if not order:
                continue
            db.refresh(order)
            match_det: OrdenDetalle | None = None
            producto_nombre_l = producto_nombre.lower()
            for d in order.detalles:
                nombre = d.producto.nombre if d.producto else ""
                if producto_nombre_l in nombre.lower():
                    match_det = d
                    break
            if not match_det:
                continue
            prev_entregados = int(getattr(match_det, "entregados", 0))
            nuevo = max(0, min(prev_entregados + cantidad, match_det.cantidad))
            match_det.entregados = nuevo
            match_det.entregado = nuevo >= match_det.cantidad
            all_delivered = all(int(getattr(d, "entregados", 0)) >= d.cantidad for d in order.detalles)
            any_delivered = any(int(getattr(d, "entregados", 0)) > 0 for d in order.detalles)
            order.estado = "entregado" if all_delivered else ("en_proceso" if any_delivered else "pendiente")
            db.commit()
            db.refresh(order)
            try:
                items = []
                for d in order.detalles:
                    prod = db.get(Producto, d.producto_id)
                    entregados = int(getattr(d, "entregados", 0))
                    items.append(
                        {
                            "producto_id": d.producto_id,
                            "nombre": prod.nombre if prod else "",
                            "precio": float(prod.precio) if prod else 0.0,
                            "cantidad": d.cantidad,
                            "entregado": entregados >= d.cantidad,
                            "entregados": entregados,
                        }
                    )
                request.app.state.order_manager.broadcast(
                    {
                        "type": "update_order",
                        "order": {
                            "id": order.id,
                            "mesa_numero": order.mesa.numero if order.mesa else None,
                            "fecha": order.fecha.isoformat(),
                            "estado": order.estado,
                            "items": items,
                            "pagado": False,
                        },
                    }
                )
            except Exception:
                pass
            applied.append(
                VoiceOperation(
                    type="increment_items_ready_by_name",
                    order_id=order.id,
                    mesa_numero=mesa_numero,
                    producto_nombre=producto_nombre,
                    cantidad=cantidad,
                )
            )
        elif t == "cancel_order_by_mesa":
            mesa_numero = op.get("mesa_numero")
            if not isinstance(mesa_numero, int):
                continue
            order = _find_open_order_for_mesa(db, mesa_numero)
            if not order:
                continue
            oid = order.id
            db.delete(order)
            db.commit()
            try:
                request.app.state.order_manager.broadcast({"type": "order_cancelled", "orden_id": oid})
            except Exception:
                pass
            applied.append(
                VoiceOperation(
                    type="cancel_order_by_mesa",
                    mesa_numero=mesa_numero,
                    order_id=oid,
                )
            )
    return applied


@router.post("/voice/command", response_model=VoiceCommandOut)
def handle_voice_command(payload: VoiceCommandIn, request: Request, db: Session = Depends(get_db)):
    text = payload.text.strip()
    orders = _active_orders(db)
    orders_for_ai = _serialize_orders_for_ai(orders)
    low = text.lower()
    if any(
        p in low
        for p in [
            "que tenemos pendiente",
            "qué tenemos pendiente",
            "que ordenes faltan",
            "qué ordenes faltan",
            "que órdenes faltan",
            "qué órdenes faltan",
            "estado de pedidos",
            "estado de las ordenes",
            "estado de las órdenes",
            "que falta en cocina",
            "qué falta en cocina",
            "que falta",
            "qué falta",
        ]
    ):
        spoken = _build_status_summary(orders_for_ai)
        return VoiceCommandOut(spoken_response=spoken, operations=[VoiceOperation(type="query_status")])
    client = _ensure_groq_client()
    system_msg = (
        "Eres un asistente de voz para una taquería en México. "
        "Recibes comandos de voz del taquero o administrador y tienes acceso al estado de las órdenes activas. "
        "Tu respuesta debe estar siempre en español mexicano, con tono natural, corto y centrado en cocina y mesas. "
        "Analiza el comando de usuario y la lista de órdenes. "
        "Debes responder con un JSON que describa las operaciones a ejecutar y el texto que se leerá en voz alta. "
        "Respeta exactamente el siguiente formato: "
        "{"
        '"operations":[{"type":"query_status"|"set_order_state_by_id"|"increment_items_ready_by_name"|"cancel_order_by_mesa",'
        '"order_id":int opcional,'
        '"mesa_numero":int opcional,'
        '"producto_nombre":string opcional,'
        '"cantidad":int opcional,'
        '"estado":"pendiente"|"en_proceso"|"entregado" opcional}],'
        '"spoken_response":"frase para leer en voz alta en español mexicano"'
        "}. "
        "No expliques el JSON, no agregues texto fuera del JSON."
    )
    user_payload = {
        "command": text,
        "ordenes": orders_for_ai,
        "instrucciones": {
            "ejemplos": [
                "¿qué tenemos pendiente?",
                "¿qué órdenes faltan?",
                "estado de pedidos",
                "cancelar orden mesa 4",
                "marcar como completado pedido 23",
                "dos de asada para la mesa uno están listos",
            ]
        },
    }
    completion = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": system_msg},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
        ],
        temperature=0.2,
        max_completion_tokens=512,
    )
    content = completion.choices[0].message.content or ""
    parsed = _parse_ai_response(content)
    ops = parsed.get("operations") or []
    if not isinstance(ops, list):
        ops = []
    applied = _apply_voice_operations(ops, request, db)
    spoken = parsed.get("spoken_response")
    if not isinstance(spoken, str) or not spoken.strip():
        if not orders:
            spoken = "No hay órdenes activas ahorita."
        else:
            spoken = "Todo en orden, las comandas siguen en cocina."
    return VoiceCommandOut(spoken_response=spoken, operations=applied)
