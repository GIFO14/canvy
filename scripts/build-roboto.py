"""Generate offline static faces from the OFL Google Fonts Roboto source.

Input: artifacts/Roboto-variable.ttf from google/fonts/ofl/roboto.
Run only when updating the bundled font, not during application startup.
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

for style, weight in [('Regular', 400), ('Medium', 500), ('SemiBold', 600), ('Bold', 700), ('ExtraBold', 800)]:
    font = instantiateVariableFont(TTFont('artifacts/Roboto-variable.ttf'), {'wdth': 100, 'wght': weight}, inplace=True)
    # Use distinct subfamilies so Skia resolves the actual weight, not synthetic bold.
    for nid, value in [(1, 'Roboto'), (2, style), (4, f'Roboto {style}'), (6, f'Roboto-{style}'), (16, 'Roboto'), (17, style)]:
        font['name'].setName(value, nid, 3, 1, 0x409)
    font['OS/2'].usWeightClass = weight
    font.save(Path('public') / f'Roboto-{style}.ttf')
