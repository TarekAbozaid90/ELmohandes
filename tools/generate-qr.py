#!/usr/bin/env python3
"""Optional: regenerate the print files (pip install 'qrcode[pil]')."""
from base64 import b64encode
from io import BytesIO
from pathlib import Path
import subprocess

import qrcode
from PIL import Image, ImageDraw, ImageOps
from qrcode.util import pattern_position

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'public' / 'assets'
TARGET = subprocess.check_output(['node', '-e', "process.stdout.write(require('./server/contact').QR_TARGET)"], cwd=ROOT, text=True)
NAVY = '#0a1e3a'
BORDER = 5
qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, border=BORDER, box_size=32)
qr.add_data(TARGET)
qr.make(fit=True)
matrix = qr.get_matrix()
size = len(matrix)
center = size / 2
plate = 9  # nine square modules only; never covers a finder or timing pattern
start = (size - plate) // 2
for row in pattern_position(qr.version):
    for col in pattern_position(qr.version):
        if (row, col) in [(6, 6), (6, qr.modules_count - 7), (qr.modules_count - 7, 6)]:
            continue
        assert (abs(row + BORDER + .5 - center) >= plate / 2 + 2.5 or
                abs(col + BORDER + .5 - center) >= plate / 2 + 2.5), 'Logo would cover an alignment pattern'

# A circular crop of the supplied logo preserves the original branding.
logo_size = 224
mark = ImageOps.fit(Image.open(ASSETS / 'logo-circle.jpg').convert('RGB'), (logo_size, logo_size), Image.Resampling.LANCZOS)
mask = Image.new('L', (logo_size * 3, logo_size * 3))
ImageDraw.Draw(mask).ellipse((1, 1, logo_size * 3 - 2, logo_size * 3 - 2), fill=255)
mark.putalpha(mask.resize((logo_size, logo_size), Image.Resampling.LANCZOS))
image = qr.make_image(fill_color=NAVY, back_color='white').convert('RGB')
step = qr.box_size
begin, end = start * step, (start + plate) * step
ImageDraw.Draw(image).rectangle((begin, begin, end - 1, end - 1), fill='white')
offset = (image.width - logo_size) // 2
image.paste(mark, (offset, offset), mark)
image.save(ASSETS / 'elmohandes-qr.png', dpi=(300, 300), optimize=True)

runs = []
for y, row in enumerate(matrix):
    x = 0
    while x < size:
        if not row[x]:
            x += 1
            continue
        first = x
        while x < size and row[x]:
            x += 1
        runs.append(f'M{first} {y}h{x-first}v1h-{x-first}z')
data = BytesIO()
mark.save(data, 'PNG', optimize=True)
logo_ref = b64encode(data.getvalue()).decode('ascii')
logo_units = logo_size / step
logo_pos = (size - logo_units) / 2
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {size} {size}" width="{image.width}" height="{image.height}" role="img" aria-labelledby="description">
<title id="description">رمز QR لمركز المهندس الشامل — {TARGET}</title>
<rect width="{size}" height="{size}" fill="#fff"/>
<path d="{''.join(runs)}" fill="{NAVY}" shape-rendering="crispEdges"/>
<rect x="{start}" y="{start}" width="{plate}" height="{plate}" fill="#fff" shape-rendering="crispEdges"/>
<image x="{logo_pos}" y="{logo_pos}" width="{logo_units}" height="{logo_units}" xlink:href="data:image/png;base64,{logo_ref}"/>
</svg>'''
(ASSETS / 'elmohandes-qr.svg').write_text(svg, encoding='utf-8')
print(f'{TARGET} — version {qr.version}, {qr.modules_count} modules, {image.width} × {image.height} px')
