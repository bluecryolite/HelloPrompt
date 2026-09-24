# Local Whisper model setup

The Hello Speech page loads Whisper in the browser through Transformers.js. Remote model loading is disabled, so the model files must be served by the same HelloPrompt server.

## Required directory layout

Keep the model identifier below the configured model root. With the default configuration, use:

```text
public/
└── models/
    └── whisper/
        └── Xenova/
            └── whisper-small.en/
                ├── config.json
                ├── generation_config.json
                ├── preprocessor_config.json
                ├── tokenizer.json
                ├── tokenizer_config.json
                └── onnx/
                    ├── encoder_model_quantized.onnx
                    └── decoder_model_merged_quantized.onnx
```

The exact ONNX filename can vary by the model revision and Transformers.js dtype. If `VITE_WHISPER_DTYPE=q8`, the common Transformers.js assets are the quantized encoder and merged decoder ONNX files. Keep the filenames and relative directory exactly as published by the selected `Xenova/whisper-small.en` revision; do not flatten the `onnx/` directory.

## Downloading the model

Review the model repository and license before distributing the binary files. With the Hugging Face CLI installed, download the model to a temporary directory and copy the complete required layout:

```bash
mkdir -p public/models/whisper
hf download Xenova/whisper-small.en \
  --local-dir /Users/md07/code/HelloPrompt/public/models/whisper/Xenova/whisper-small.en \
  --include 'config.json' \
  --include 'generation_config.json' \
  --include 'preprocessor_config.json' \
  --include 'tokenizer.json' \
  --include 'tokenizer_config.json' \
  --include 'onnx/encoder_model_fp16.onnx' \
  --include 'onnx/decoder_model_merged_fp16.onnx'
cp -R /tmp/whisper-small.en public/models/whisper/Xenova/whisper-small.en
```

If the downloaded directory already contains `Xenova/whisper-small.en`, copy its contents so the final path is not duplicated. Both quantized ONNX assets should be available at:

```text
public/models/whisper/Xenova/whisper-small.en/onnx/encoder_model_quantized.onnx
public/models/whisper/Xenova/whisper-small.en/onnx/decoder_model_merged_quantized.onnx
```

For a smaller or WebGPU-specific artifact, set the matching non-secret value in `.env`:

```text
VITE_WHISPER_DTYPE=q8
VITE_WHISPER_MODEL_ID=Xenova/whisper-small.en
VITE_WHISPER_ASSET_BASE_URL=/models/whisper/
```

Do not put credentials in these values. The model is downloaded before the app runs; the browser must not fall back to Hugging Face.

## Localhost URL mapping

`public/` is Vite's static web root. Filesystem paths become same-origin URLs:

```text
public/models/whisper/Xenova/whisper-small.en/config.json
  -> http://localhost:30001/models/whisper/Xenova/whisper-small.en/config.json

public/models/whisper/Xenova/whisper-small.en/onnx/encoder_model_quantized.onnx
  -> http://localhost:30001/models/whisper/Xenova/whisper-small.en/onnx/encoder_model_quantized.onnx

public/models/whisper/Xenova/whisper-small.en/onnx/decoder_model_merged_quantized.onnx
  -> http://localhost:30001/models/whisper/Xenova/whisper-small.en/onnx/decoder_model_merged_quantized.onnx
```

Use `/models/whisper/` in browser configuration, never a developer-machine absolute path such as `/Users/...` or `C:\...`. Open the mapped `config.json` URL in the browser or use the Network panel during model initialization to confirm that all requests are same-origin and return `200`. A missing file should produce a visible initialization error rather than a remote download.

Large model binaries may be better managed with Git LFS or release storage. Keep the same `public/models/whisper/Xenova/whisper-small.en/` layout when restoring them locally.
