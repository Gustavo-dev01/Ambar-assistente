"""Gera web/icon.ico a partir do mark do agente (mesmo desenho de 8 raios usado em
#sidebar-mark / tela de logout no protótipo), na paleta âmbar do tema escuro.
Rodar sob demanda (`./.venv/Scripts/python.exe scripts/generate_icon.py`) — não faz
parte do runtime do app.
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

BG = (26, 26, 26, 255)  # --text-primary do tema claro / fundo escuro do mark
MARK = (204, 154, 0, 255)  # --interactive-default do tema escuro (âmbar/dourado)

SIZES = [16, 24, 32, 48, 64, 128, 256]


def draw_mark(size: int) -> Image.Image:
    scale = size / 24
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    cx = cy = size / 2
    r_outer = 8.5 * scale
    r_inner = 3.2 * scale
    stroke = max(1, round(1.8 * scale))

    # Círculo de fundo (mesmo padrão visual do orb: disco escuro atrás do mark).
    pad = 1.0 * scale
    draw.ellipse([pad, pad, size - pad, size - pad], fill=BG)

    # 8 raios saindo do centro, como o path original (12,8->12,3 e as 7 rotações de 45°).
    for i in range(8):
        angle = math.radians(i * 45 - 90)
        x1 = cx + r_inner * math.cos(angle)
        y1 = cy + r_inner * math.sin(angle)
        x2 = cx + r_outer * math.cos(angle)
        y2 = cy + r_outer * math.sin(angle)
        draw.line([x1, y1, x2, y2], fill=MARK, width=stroke)

    return img


def main() -> None:
    out_path = Path(__file__).resolve().parent.parent / "web" / "icon.ico"
    # Desenha direto no maior tamanho e deixa o Pillow reamostrar pros menores — gera
    # frames de verdade pra cada tamanho dentro do .ico (a API save(sizes=...) sozinha
    # não gera desenhos distintos por tamanho, só redimensiona a imagem base).
    base = draw_mark(256)
    base.save(out_path, format="ICO", sizes=[(s, s) for s in SIZES])
    print(f"Ícone gerado: {out_path}")


if __name__ == "__main__":
    main()