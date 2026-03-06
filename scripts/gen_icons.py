from PIL import Image, ImageDraw
import os

out = '/work/extension/icons'
os.makedirs(out, exist_ok=True)

def make_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = size // 8 * 2
    d.rounded_rectangle([0, 0, size-1, size-1], radius=r, fill='#f0a500')
    cx, s = size // 2, size
    d.rectangle([cx - s//10, s//5, cx + s//10, s//2], fill='#000')
    d.polygon([(cx - s//4, s//2), (cx + s//4, s//2), (cx, s*2//3)], fill='#000')
    thick = max(2, s // 14)
    d.rectangle([s//5, s*3//4, s*4//5, s*3//4 + thick], fill='#000')
    return img

for sz in [48, 128]:
    make_icon(sz).save(f'{out}/icon{sz}.png')
    print(f'Generated icon{sz}.png')
