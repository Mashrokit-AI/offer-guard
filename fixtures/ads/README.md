# Offer Guard test fixtures (synthetic)
Fictional brand GALI. Approved offer: see offer-spec.json (20% off selected models, paid shipping, until 10.11).

| File | Expected verdict | Why |
|---|---|---|
| ad-01-clean.png | CLEAN | panel matches the spec |
| ad-02-wrong.png | AD_WRONG_REPAIRABLE | panel promises 30% on everything + free shipping; panel is separate from product and logo |
| ad-03-overlap.png | AD_WRONG_UNSAFE | same wrong promise, but the panel overlaps the product → must refuse |
| ad-01-clean-en.png | CLEAN | English twin of ad-01 ("20% off selected models" / "Valid until 10.11 · paid shipping") |
| ad-02-wrong-en.png | AD_WRONG_REPAIRABLE | English twin of ad-02 ("30% off everything" / "+ free shipping · valid until 10.11") |
| ad-03-overlap-en.png | AD_WRONG_UNSAFE | English twin of ad-03 |

The English set uses the same layout and geometry (logo top right, panel in the same place); only the text and `lang/dir` differ.

Source: src/ad.html rendered with headless Chrome at 1080×1080. Regenerate with the same template if you change the text.
