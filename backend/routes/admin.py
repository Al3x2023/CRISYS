from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse, Response
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
import io
import zipfile
import qrcode

from database import get_db
from models import Mesa
from qrcode.image.styledpil import StyledPilImage
from qrcode.image.styles.moduledrawers import SquareModuleDrawer, RoundedModuleDrawer, CircleModuleDrawer, GappedSquareModuleDrawer
from qrcode.image.styles.colormasks import SolidFillColorMask
from PIL import Image, ImageDraw, ImageFont
import urllib.request

from database import get_db
from models import Mesa

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