# Local Kokoro model setup

The Hello Speech page expects Kokoro-82M assets to be served by the same HelloPrompt web server. Browser URLs are derived from the `public/` directory, so keep the model under:

```text
public/
└── models/
    └── kokoro/
        └── Kokoro-82M/
            ├── config.json
            ├── tokenizer.json
            ├── tokenizer_config.json
            ├── special_tokens_map.json
            ├── model_q8.onnx
            └── voices/
                └── af_heart.bin
```

Use the public Hugging Face model repository to download the files:

```bash
mkdir -p public/models/kokoro/Kokoro-82M
huggingface-cli download onnx-community/Kokoro-82M-v1.0-ONNX \
  --local-dir /tmp/Kokoro-82M-download \
  --include 'config.json' 'tokenizer.json' 'tokenizer_config.json' \
  --include 'special_tokens_map.json' 'onnx/model_q8.onnx' \
  --include 'voices/af_heart.bin'
mv /tmp/Kokoro-82M-download/onnx/model_q8.onnx public/models/kokoro/Kokoro-82M/model_q8.onnx
cp -R /tmp/Kokoro-82M-download/config.json \
  /tmp/Kokoro-82M-download/tokenizer.json \
  /tmp/Kokoro-82M-download/tokenizer_config.json \
  /tmp/Kokoro-82M-download/special_tokens_map.json \
  public/models/kokoro/Kokoro-82M/
cp -R /tmp/Kokoro-82M-download/voices public/models/kokoro/Kokoro-82M/
```

If `huggingface-cli` is not installed, download the same files from the repository's `resolve/main/...` URLs. Save `onnx/model_q8.onnx` as `public/models/kokoro/Kokoro-82M/model_q8.onnx`; the `onnx/` directory is only part of the upstream repository layout and must not remain in the local `public/` layout. The ONNX filename must match the configured `VITE_KOKORO_DTYPE`; the default `q8` configuration expects `model_q8.onnx`.

The filesystem paths become same-origin browser URLs:

```text
public/models/kokoro/Kokoro-82M/config.json
  -> http://localhost:30001/models/kokoro/Kokoro-82M/config.json
public/models/kokoro/Kokoro-82M/model_q8.onnx
  -> http://localhost:30001/models/kokoro/Kokoro-82M/model_q8.onnx
public/models/kokoro/Kokoro-82M/voices/af_heart.bin
  -> http://localhost:30001/models/kokoro/Kokoro-82M/voices/af_heart.bin
```

Do not use a developer-machine absolute filesystem path in browser configuration. Transformers.js receives `/models/kokoro/` as its local model root and resolves `Kokoro-82M` below it. The application explicitly sets the model subfolder to the empty string, so the ONNX file is loaded directly from the model directory. Remote model loading is disabled, so missing files fail visibly instead of silently downloading from Hugging Face.

The model and voice weights are binary assets. Check the upstream Apache-2.0 licensing terms and repository size policy before committing them to ordinary Git. If the project uses Git LFS or release storage, keep the same directory structure and make the setup step fetch the files there. Generated speech is kept in memory and is not written into this directory.
