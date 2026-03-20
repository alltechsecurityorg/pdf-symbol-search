# Next Features

## 1. Multi Site Pages
Support loading and searching across multiple site plan PDFs simultaneously, not just a single site PDF. Allow users to queue up several site plans and run a batch search across all of them with combined results.

## 2. Multi-Page / Multi-File Search Options
Add page range selection and multi-file targeting for searches. Users should be able to specify which pages or files to search (e.g. "Pages 1-10, 15, 20-25") instead of always searching the entire document.

## 3. Auto-Select Legend Symbols
Automatically detect and extract symbols from a legend PDF rather than requiring manual cropping. Use image segmentation or layout analysis to identify individual symbol entries on a legend page and pre-populate the symbol list.

## 4. Improved Pattern Recognition Quality
Enhance the two-stage matching pipeline for higher accuracy and fewer false positives. Potential improvements:
- More granular scale/rotation steps
- Adaptive thresholding per symbol
- Better handling of overlapping/adjacent symbols
- Machine learning-based validation stage

## 5. Hybrid Text + Pattern Recognition
Combine OCR text matching with the existing visual template matching. Many construction symbols have associated text labels (e.g. "SD" for smoke detector). Cross-referencing detected text near visual matches would reduce false positives and enable text-based symbol discovery.
