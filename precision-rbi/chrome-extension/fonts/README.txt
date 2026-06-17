Precision RBI — fonts
=====================

The UI references two bundled typefaces via @font-face in fonts.css:

  - PlayfairDisplay.woff2   (headings)
  - Montserrat.woff2        (body / UI)

These BINARY font files are NOT included in the repo because they cannot be
fetched on an air-gapped / domain-restricted build host. The UI falls back to
clean system fonts (Georgia / system-ui) until you add them — nothing breaks and
no CDN is ever contacted.

To bundle the real fonts (run ONCE on a machine WITH internet, then ship offline):

  # Playfair Display (regular)
  curl -L -o PlayfairDisplay.woff2 \
    "https://github.com/google/fonts/raw/main/ofl/playfairdisplay/PlayfairDisplay%5Bwght%5D.woff2" \
    || echo "Adjust the URL to the current Google Fonts repo path."

  # Montserrat (regular)
  curl -L -o Montserrat.woff2 \
    "https://github.com/google/fonts/raw/main/ofl/montserrat/Montserrat%5Bwght%5D.woff2" \
    || echo "Adjust the URL to the current Google Fonts repo path."

Place both files in this directory. The @font-face rules already point here.
Do NOT add a Google Fonts <link>/@import — that would violate the air-gap rule.
