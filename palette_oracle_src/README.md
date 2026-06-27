# Palette card generator

Place an image inside the `Palette_input/` folder and run:

```bash
pip install -r requirements.txt
python palette_maker.py
```

The script will:
- take the latest image from `Palette_input/`
- apply a strong blur to the background
- extract 5 dominant colors
- map them to human-friendly names (uses `webcolors` when available)
- draw a palette card and save PNG to `Palette_output/`
