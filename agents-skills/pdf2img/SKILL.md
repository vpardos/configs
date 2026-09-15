---
name: pdf2img
description: Convert PDF pages to high-fidelity images, optimized for math symbol rendering. Use when the user needs to convert math PDFs to images for vision model analysis, extract pages as screenshots, or prepare PDF content for AI models without native PDF support. Handles LaTeX, STIX, and Unicode math symbols with pixel-perfect accuracy via PyMuPDF/MuPDF engine.
---

# PDF to Image Converter (Math-Optimized)

Convert PDF pages to PNG/JPEG images with precise rendering of mathematical symbols, formulas, and technical notation.

## When to Use

- Converting math problem sets to images for vision-capable AI models
- Preparing PDF pages for `@observer` analysis when the model lacks native PDF support
- Extracting specific pages as high-resolution screenshots
- Rendering LaTeX-generated PDFs with embedded math fonts (Computer Modern, STIX)
- Creating image batches from technical/scientific documents

**When NOT to use:**

- Need to extract text programmatically (use `pdftotext` or PyMuPDF text extraction)
- Need to edit the PDF (use a PDF editor)
- Simple text-only PDFs where a screenshot suffices

## Tool Location

- **Script:** `/home/vpardos/pdf2img.py`
- **Wrapper:** `/home/vpardos/pdf2img` (shell wrapper, callable directly)
- **PATH symlink:** `~/.local/bin/pdf2img` (in PATH)
- **Python env:** `/home/vpardos/pdf-tools-env/`
- **Dependency:** PyMuPDF 1.28.2 (MuPDF 1.28.2 engine)

## Usage

### Basic

```bash
pdf2img input.pdf                    # all pages → PNG at 300 DPI
pdf2img input.pdf -d 600             # 600 DPI for tiny/dense math
pdf2img input.pdf -f 3 -l 7          # pages 3–7 only
pdf2img input.pdf -o /tmp/out        # custom output directory
pdf2img input.pdf --format jpg -q 95 # JPEG output
pdf2img input.pdf --prefix problem   # custom filename prefix
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `-d, --dpi` | 300 | Output resolution. Use 300 for general, 600 for dense/tiny math |
| `-f, --first` | 1 | First page (1-indexed) |
| `-l, --last` | last | Last page (1-indexed) |
| `-o, --output` | `<pdf>_images/` | Output directory |
| `--format` | png | Output format: png, jpg, jpeg, ppm, tiff |
| `-q, --quality` | 95 | JPEG quality (1–100) |
| `--prefix` | PDF basename | Filename prefix |
| `--alpha` | off | Include transparency channel |

### DPI Guidance for Math

| DPI | Use case |
|-----|----------|
| 150 | Quick preview, large fonts only |
| 300 | Standard — good for most math PDFs |
| 600 | Dense notation, subscripts, small fractions |
| 1200 | Extreme zoom / print-quality reproduction |

## Workflow: Math PDF → Vision Model

Typical pattern for using AI models without native PDF support:

```bash
# 1. Convert the math PDF to images
pdf2img problem_set.pdf -d 300 -o ./math_images

# 2. Images are saved as: math_images/problem_set_page_0001.png, etc.

# 3. Feed images to @observer or a vision model for analysis
```

When delegating to `@observer`, pass the full image path:
> "Analyze the math problems in /path/to/math_images/problem_set_page_0001.png — describe each problem and solve it step by step."

## Why PyMuPDF for Math

- **MuPDF engine** renders vector paths and embedded fonts natively — LaTeX math (Computer Modern, STIX, Latin Modern) reproduces faithfully since fonts are already embedded in the PDF
- **No Ghostscript dependency** — fewer font-substitution artifacts than ImageMagick or poppler-based tools
- **2–5× faster** than poppler-based tools (pdftoppm, pdf2image)
- **Pure pip install** — no system packages required beyond the venv

## Troubleshooting

**Missing symbols or garbled math:**
The source PDF likely has non-embedded fonts. This is a PDF issue, not a rendering issue. Check with: `pdffonts input.pdf` (if poppler is installed) or open in a browser to compare.

**Output too large:**
Lower DPI or use JPEG: `pdf2img input.pdf -d 150 --format jpg -q 85`

**Need specific pages only:**
Use `-f` and `-l`: `pdf2img input.pdf -f 5 -l 5` for a single page.
